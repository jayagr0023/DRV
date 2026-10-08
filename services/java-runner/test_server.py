from __future__ import annotations

import json
import unittest
from typing import Any

from server import run_trace


def trace(code: str, stdin: str = "") -> list[dict[str, Any]]:
    return [
        json.loads(record)
        for record in run_trace({"language": "java", "code": code, "stdin": stdin})
    ]


def trace_steps(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [record["data"] for record in records if record["type"] == "step"]


def trace_heaps(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    heaps = []
    for step in trace_steps(records):
        if step["storage"] == "keyframe":
            heaps.append(step["snapshot"]["heap"])
        else:
            heaps.extend(
                patch["value"]
                for patch in step["patch"]
                if patch["path"] == "/heap"
            )
    return heaps


def trace_stacks(records: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    stacks = []
    for step in trace_steps(records):
        if step["storage"] == "keyframe":
            stacks.append(step["snapshot"]["stack"])
        else:
            stacks.extend(
                patch["value"]
                for patch in step["patch"]
                if patch["path"] == "/stack"
            )
    return stacks


class JavaRunnerTests(unittest.TestCase):
    def test_traces_method_return_values(self) -> None:
        records = trace(
            """public class Main {
    static int add(int left, int right) {
        return left + right;
    }
    public static void main(String[] args) {
        int result = add(2, 3);
    }
}
"""
        )

        steps = trace_steps(records)
        return_events = []
        for step in steps:
            event = step["snapshot"]["event"] if step["storage"] == "keyframe" else step["event"]
            if event != "return":
                continue
            return_value = (
                step["snapshot"].get("returnValue")
                if step["storage"] == "keyframe"
                else step.get("returnValue")
            )
            return_events.append((step, return_value))

        self.assertEqual(records[-1]["end"]["status"], "ok")
        add_return = next(
            (value for step, value in return_events
             if (step["snapshot"]["frame"] if step["storage"] == "keyframe" else step["frame"])["method"] == "add"),
            None,
        )
        self.assertEqual(add_return, {"kind": "prim", "type": "int", "value": 5})
        self.assertTrue(any(value is None for _, value in return_events))

    def test_traces_two_sum_without_java_util_imports(self) -> None:
        code = """public class Main {
    public static int[] twoSum(int[] nums, int target) {
        int n = nums.length;
        Map<Integer, Integer> map = new HashMap<>();
        for (int i = 0; i < n; i++) {
            int compliment = target - nums[i];
            if (map.containsKey(compliment)) {
                return new int[] { i, map.get(compliment) };
            }
            map.put(nums[i], i);
        }
        return new int[] {-1,-1};
    }
    public static void main(String[] args) {
        int[] ans=twoSum(new int[]{1,2,3,4,5,6}, 7);
    }
}
"""
        records = trace(code)

        self.assertEqual(records[-1]["end"]["status"], "ok")
        self.assertGreater(len(trace_steps(records)), 0)
        heaps = trace_heaps(records)
        self.assertTrue(any(
            obj["type"] == "java.util.HashMap"
            for heap in heaps
            for obj in heap.values()
        ))
        lines = [
            step["snapshot"]["line"] if step["storage"] == "keyframe" else step["line"]
            for step in trace_steps(records)
        ]
        self.assertTrue(all(1 <= line <= len(code.splitlines()) for line in lines))

    def test_infers_imports_from_other_standard_jdk_packages(self) -> None:
        records = trace(
            """public class Main {
    public static void main(String[] args) {
        LocalDate date = LocalDate.of(2024, 2, 29);
        AtomicInteger counter = new AtomicInteger(date.getDayOfMonth());
        System.out.println(counter.incrementAndGet());
    }
}
"""
        )

        self.assertEqual(records[-1]["end"]["status"], "ok")
        self.assertIn("30", "".join(
            step["snapshot"]["stdout"] if step["storage"] == "keyframe" else step["stdout"]
            for step in trace_steps(records)
        ))

    def test_traces_recursive_parentheses_backtracking(self) -> None:
        records = trace(
            """public class Main {
    public static List<String> removeInvalidParentheses(String s) {
        int n = s.length();
        List<String> ans = new ArrayList<>();
        helper(s, ans, 0, n, 0, new StringBuilder());
        return ans;
    }
    private static void helper(String s, List<String> ans, int i, int n, int open, StringBuilder sb) {
        if (i >= n) {
            if (sb.length() % 2 != 0) return;
            if (!ans.contains(sb.toString())) ans.add(sb.toString());
            return;
        }
        if (s.charAt(i) == ')' && open == 0) {
            helper(s, ans, i + 1, n, open, sb);
            return;
        }
        if (s.charAt(i) == '(') open++;
        else if (s.charAt(i) == ')') open--;
        sb.append(s.charAt(i));
        helper(s, ans, i + 1, n, open, sb);
        sb.deleteCharAt(sb.length() - 1);
        helper(s, ans, i + 1, n, open, sb);
    }
    public static void main(String[] args) {
        List<String> ans = new ArrayList<>(removeInvalidParentheses("()()())"));
        System.out.println(ans);
    }
}
"""
        )

        steps = trace_steps(records)
        stdout = "".join(
            step["snapshot"]["stdout"] if step["storage"] == "keyframe" else step["stdout"]
            for step in steps
        )
        self.assertEqual(records[-1]["end"]["status"], "ok")
        self.assertIn("[", stdout)

    def test_reports_compile_error_with_source_line(self) -> None:
        records = trace(
            """public class Broken {
    public static void main(String[] args) {
        int = 3;
    }
}
"""
        )

        end = records[-1]["end"]
        self.assertEqual(end["status"], "compile_error")
        self.assertEqual(end["diagnostics"][0]["line"], 3)
        self.assertTrue(end["diagnostics"][0]["message"])

    def test_compile_error_line_stays_aligned_after_inferred_import(self) -> None:
        records = trace(
            """public class Main {
    public static void main(String[] args) {
        Map<Integer, Integer> values = new HashMap<>();
        int = values.size();
    }
}
"""
        )

        end = records[-1]["end"]
        self.assertEqual(end["status"], "compile_error")
        self.assertEqual(end["diagnostics"][0]["line"], 4)

    def test_traces_helper_classes_and_packaged_sources(self) -> None:
        records = trace(
            """/* public class Ghost { static void main(String[] args) {} } */
package algorithms;
public class Solution {
    public static void main(String[] args) {
        Node node = new Node(5);
        node.visit();
    }
}
class Node {
    int value;
    Node(int value) { this.value = value; }
    void visit() { System.out.println(value); }
}
""".replace("\n", "\r\n")
        )

        steps = trace_steps(records)
        self.assertIn(
            "algorithms.Node",
            {
                (step["snapshot"]["frame"] if step["storage"] == "keyframe" else step["frame"])["class"]
                for step in steps
            },
        )
        self.assertTrue(any(
            frame["method"] == "visit"
            for stack in trace_stacks(records)
            for frame in stack
        ))
        self.assertIn(
            12,
            [
                step["snapshot"]["line"] if step["storage"] == "keyframe" else step["line"]
                for step in steps
                if (
                    step["snapshot"]["frame"]["class"]
                    if step["storage"] == "keyframe"
                    else step["frame"]["class"]
                ) == "algorithms.Node"
                and (
                    step["snapshot"]["frame"]["method"]
                    if step["storage"] == "keyframe"
                    else step["frame"]["method"]
                ) == "visit"
            ],
        )
        self.assertEqual(records[-1]["end"]["status"], "ok")

    def test_runs_record_based_main_class(self) -> None:
        records = trace(
            """public record Main(int value) {
    public static void main(String[] args) {
        System.out.println(new Main(6).value());
    }
}
"""
        )

        self.assertEqual(records[-1]["end"]["status"], "ok")
        self.assertIn("6", "".join(
            step["snapshot"]["stdout"] if step["storage"] == "keyframe" else step["stdout"]
            for step in trace_steps(records)
        ))

    def test_selects_top_level_main_over_nested_main(self) -> None:
        records = trace(
            """public class Main {
    static class Nested {
        public static void main(String[] args) {
            System.out.println("nested");
        }
    }
}
class Solution {
    public static void main(String[] args) {
        System.out.println("selected");
    }
}
"""
        )

        steps = trace_steps(records)
        self.assertEqual(records[-1]["end"]["status"], "ok")
        self.assertEqual(steps[0]["snapshot"]["frame"]["class"], "Solution")
        self.assertIn("selected", "".join(
            step["snapshot"]["stdout"] if step["storage"] == "keyframe" else step["stdout"]
            for step in steps
        ))

    def test_reports_runtime_exception_with_source_line(self) -> None:
        records = trace(
            """public class Main {
    public static void main(String[] args) {
        int divisor = 0;
        int result = 6 / divisor;
    }
}
"""
        )

        end = records[-1]["end"]
        self.assertEqual(end["status"], "runtime_error")
        self.assertTrue(end["diagnostics"])
        self.assertEqual(end["diagnostics"][0]["line"], 4)
        self.assertIn("ArithmeticException", end["diagnostics"][0]["message"])

    def test_runs_programs_using_standard_input(self) -> None:
        records = trace(
            """import java.util.Scanner;
public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        int left = scanner.nextInt();
        int right = scanner.nextInt();
        System.out.println(left + right);
    }
}
""",
            "17 25\n",
        )

        self.assertEqual(records[-1]["end"]["status"], "ok")
        self.assertIn("42", "".join(
            step["snapshot"]["stdout"] if step["storage"] == "keyframe" else step["stdout"]
            for step in trace_steps(records)
        ))

    def test_runs_prefix_sum_program_with_multiple_scanner_inputs(self) -> None:
        records = trace(
            """public class Main {
    static void printarray(int[] arr) {
        for (int i = 1; i < arr.length; i++) {
            System.out.print(arr[i] + " ");
        }
    }
    static int[] prefix(int[] arr) {
        for (int i = 1; i < arr.length; i++) {
            arr[i] += arr[i - 1];
        }
        return arr;
    }
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        int[] arr = new int[n + 1];
        for (int i = 1; i <= n; i++) arr[i] = sc.nextInt();
        printarray(arr);
        int[] prefsumarr = prefix(arr);
        printarray(prefsumarr);
        int q = sc.nextInt();
        while (q-- > 0) {
            int l = sc.nextInt();
            int r = sc.nextInt();
            System.out.println("Sum is " + (prefsumarr[r] - prefsumarr[l - 1]));
        }
        sc.close();
    }
}
""",
            "5\n1 2 3 4 5\n2\n1 3\n2 5\n",
        )

        self.assertEqual(records[-1]["end"]["status"], "ok")
        steps = trace_steps(records)
        standard_output = "".join(
            step["snapshot"]["stdout"] if step["storage"] == "keyframe" else step["stdout"]
            for step in steps
        )
        self.assertIn("1 2 3 4 5", standard_output)
        self.assertIn("1 3 6 10 15", standard_output)
        self.assertIn("Sum is 6", standard_output)
        self.assertIn("Sum is 14", standard_output)
        scanner_was_summarized = False
        for step in steps:
            snapshot = step["snapshot"] if step["storage"] == "keyframe" else None
            if snapshot is None:
                continue
            scanner = next(
                (
                    obj
                    for obj in snapshot["heap"].values()
                    if obj["type"] == "java.util.Scanner"
                ),
                None,
            )
            if scanner is not None:
                self.assertTrue(scanner["truncated"])
                self.assertEqual(scanner["fields"], {})
                scanner_was_summarized = True
        self.assertTrue(scanner_was_summarized, "Expected a captured Scanner to be summarized.")

    def test_captures_standard_collection_internals(self) -> None:
        records = trace(
            """import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
public class Main {
    public static void main(String[] args) {
        List<Integer> values = new ArrayList<>();
        values.add(3);
        values.add(8);
        Map<Integer, String> labels = new HashMap<>();
        labels.put(3, "three");
        System.out.println(values.size() + labels.size());
    }
}
""".replace("\n", "\r\n")
        )

        heaps = trace_heaps(records)
        self.assertTrue(
            any(
                obj["type"] == "java.util.ArrayList"
                and {"elementData", "size"} <= set(obj.get("fields", {}))
                for heap in heaps
                for obj in heap.values()
            )
        )
        self.assertTrue(
            any(
                obj["type"] == "java.util.HashMap"
                and "table" in obj.get("fields", {})
                for heap in heaps
                for obj in heap.values()
            )
        )
        self.assertTrue(
            any(
                obj["type"] == "java.lang.Integer"
                and obj.get("fields", {}).get("value", {}).get("value") == 3
                for heap in heaps
                for obj in heap.values()
            )
        )

    def test_captures_map_queues_linked_lists_trees_and_graphs(self) -> None:
        records = trace(
            """public class Main {
    static class Node {
        int value;
        Node left;
        Node right;
        List<Node> neighbors = new ArrayList<>();
        Node(int value) { this.value = value; }
    }
    public static void main(String[] args) {
        Map<String, Integer> map = new HashMap<>();
        map.put("answer", 42);
        PriorityQueue<Integer> priorityQueue = new PriorityQueue<>();
        priorityQueue.add(9);
        priorityQueue.add(2);
        Queue<Integer> queue = new ArrayDeque<>();
        queue.add(4);
        queue.add(7);
        LinkedList<Integer> linkedList = new LinkedList<>();
        for (int value = 0; value < 12; value++) {
            linkedList.add(value);
        }
        Node root = new Node(1);
        root.left = new Node(2);
        root.right = new Node(3);
        root.neighbors.add(root.right);
        System.out.println(map.size() + priorityQueue.size() + queue.size() + linkedList.size());
    }
}
"""
        )

        types = {
            obj["type"]
            for heap in trace_heaps(records)
            for obj in heap.values()
        }
        self.assertEqual(records[-1]["end"]["status"], "ok")
        heaps = trace_heaps(records)
        objects = [obj for heap in heaps for obj in heap.values()]
        for expected_type in (
            "java.util.HashMap",
            "java.util.HashMap$Node",
            "java.util.PriorityQueue",
            "java.util.ArrayDeque",
            "java.util.LinkedList",
            "java.util.LinkedList$Node",
            "Main$Node",
        ):
            self.assertIn(expected_type, types)
        self.assertTrue(any(
            obj["type"] == "java.util.HashMap$Node"
            and {"key", "value"} <= set(obj.get("fields", {}))
            for obj in objects
        ))
        self.assertTrue(any(
            obj["type"] == "java.util.PriorityQueue"
            and {"queue", "size"} <= set(obj.get("fields", {}))
            for obj in objects
        ))
        self.assertTrue(any(
            obj["type"] == "java.util.ArrayDeque"
            and "elements" in obj.get("fields", {})
            for obj in objects
        ))
        self.assertTrue(any(
            obj["type"] == "Main$Node"
            and {"left", "right", "neighbors"} <= set(obj.get("fields", {}))
            for obj in objects
        ))
        longest_linked_list = 0
        for heap in heaps:
            linked_list = next(
                (
                    obj
                    for obj in heap.values()
                    if obj["type"] == "java.util.LinkedList"
                ),
                None,
            )
            if linked_list is None:
                continue
            node_ref = linked_list["fields"]["first"]
            visited: set[str] = set()
            size = 0
            while node_ref.get("kind") == "ref" and node_ref["id"] not in visited:
                visited.add(node_ref["id"])
                node = heap.get(node_ref["id"])
                if node is None or node["type"] != "java.util.LinkedList$Node":
                    break
                size += 1
                node_ref = node["fields"]["next"]
            longest_linked_list = max(longest_linked_list, size)
        self.assertEqual(longest_linked_list, 12)


if __name__ == "__main__":
    unittest.main()
