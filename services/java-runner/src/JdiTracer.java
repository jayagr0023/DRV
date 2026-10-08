import com.sun.jdi.Bootstrap;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.Field;
import com.sun.jdi.Location;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.VirtualMachineManager;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.connect.LaunchingConnector;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventIterator;
import com.sun.jdi.event.EventQueue;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.MethodExitEvent;
import com.sun.jdi.event.VMDeathEvent;
import com.sun.jdi.event.VMDisconnectEvent;
import com.sun.jdi.event.VMStartEvent;
import com.sun.jdi.request.EventRequestManager;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.MethodExitRequest;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class JdiTracer {
  private static final int MAX_STACK = 50;
  private static final Map<Long, String> OBJECT_IDS = new HashMap<>();
  private static int nextObjectId = 1;
  private static final String userClass = System.getenv().getOrDefault("DRYRUN_MAIN_CLASS", "Main");
  private static final String userSourceFile = System.getenv().getOrDefault("DRYRUN_SOURCE_FILE", "Main.java");
  private static final int syntheticImportCount = Integer.parseInt(
      System.getenv().getOrDefault("DRYRUN_SYNTHETIC_IMPORTS", "0"));
  private static final int importInsertionLine = Integer.parseInt(
      System.getenv().getOrDefault("DRYRUN_IMPORT_INSERTION_LINE", "0"));

  public static void main(String[] args) throws Exception {
    if (args.length < 2) throw new IllegalArgumentException("Usage: JdiTracer <classes> <stdin-file>");
    String classpath = args[0];
    String stdin = Files.readString(Path.of(args[1]), StandardCharsets.UTF_8);
    VirtualMachine vm = launch(classpath);
    Process process = vm.process();
    StreamBuffer stdout = new StreamBuffer(process.getInputStream());
    StreamBuffer stderr = new StreamBuffer(process.getErrorStream());
    stdout.start();
    stderr.start();
    try (OutputStream input = process.getOutputStream()) {
      input.write(stdin.getBytes(StandardCharsets.UTF_8));
    }

    EventRequestManager manager = vm.eventRequestManager();
    EventQueue queue = vm.eventQueue();
    var classPrepare = manager.createClassPrepareRequest();
    classPrepare.enable();
    int step = 0;
    boolean stopped = false;
    while (!stopped) {
      EventSet set = queue.remove(1000);
      if (set == null) {
        if (!process.isAlive()) break;
        continue;
      }
      EventIterator events = set.eventIterator();
      while (events.hasNext()) {
        Event event = events.nextEvent();
        if (event instanceof BreakpointEvent line) {
          Location location = line.location();
          if (isUserClass(location.declaringType()) && location.lineNumber() > 0) {
            System.out.println(snapshot(step++, line.thread(), location, stdout.take(), stderr.take(), "line", null, false));
            System.out.flush();
          }
        } else if (event instanceof MethodExitEvent exit) {
          Location location = exit.location();
          if (isUserClass(location.declaringType())) {
            boolean hasReturnValue = !exit.method().returnTypeName().equals("void");
            Value returnValue = hasReturnValue && vm.canGetMethodReturnValues() ? exit.returnValue() : null;
            System.out.println(snapshot(step++, exit.thread(), location, stdout.take(), stderr.take(), "return", returnValue, hasReturnValue));
            System.out.flush();
          }
        } else if (event instanceof ClassPrepareEvent prepared) {
          installBreakpoints(manager, prepared.referenceType(), vm.canGetMethodReturnValues());
        } else if (event instanceof VMStartEvent) {
          // Wait for the user class to prepare before requesting source steps.
        } else if (event instanceof VMDeathEvent) {
          stopped = true;
        } else if (event instanceof VMDisconnectEvent) {
          stopped = true;
        }
      }
      set.resume();
    }
    stdout.join(500);
    stderr.join(500);
    int exitCode = process.waitFor();
    System.out.println("{\"kind\":\"end\",\"status\":" + string(exitCode == 0 ? "ok" : "runtime_error")
      + ",\"exitCode\":" + exitCode + ",\"stdout\":" + string(stdout.take()) + ",\"stderr\":" + string(stderr.take()) + "}");
    System.out.flush();
    if (process.isAlive()) process.destroyForcibly();
    try {
      vm.dispose();
    } catch (com.sun.jdi.VMDisconnectedException ignored) {
      // Normal shutdown may disconnect before the tracer calls dispose.
    }
  }

  private static boolean isUserClass(ReferenceType type) {
    String name = type.name();
    if (name.equals(userClass) || name.startsWith(userClass + "$")) return true;
    try {
      return type.sourceName().equals(userSourceFile);
    } catch (com.sun.jdi.AbsentInformationException ignored) {
      return false;
    }
  }

  private static void installBreakpoints(EventRequestManager manager, ReferenceType type, boolean canGetReturnValues) {
    if (System.getenv("DRYRUN_DEBUG") != null) {
      System.err.println("prepare=" + type.name() + " user=" + userClass);
    }
    if (!isUserClass(type)) return;
    try {
      if (System.getenv("DRYRUN_DEBUG") != null) {
        System.err.println("lines=" + type.allLineLocations().size());
      }
      for (Location location : type.allLineLocations()) {
        if (location.lineNumber() <= 0) continue;
        BreakpointRequest request = manager.createBreakpointRequest(location);
        request.enable();
      }
      if (canGetReturnValues) {
        MethodExitRequest request = manager.createMethodExitRequest();
        request.addClassFilter(type);
        request.enable();
      }
    } catch (com.sun.jdi.AbsentInformationException | com.sun.jdi.VMDisconnectedException ignored) {
      // The debuggee can disconnect before all source breakpoints are installed.
    }
  }

  private static VirtualMachine launch(String classpath) throws Exception {
    VirtualMachineManager manager = Bootstrap.virtualMachineManager();
    LaunchingConnector connector = manager.defaultConnector();
    Map<String, Connector.Argument> arguments = connector.defaultArguments();
    arguments.get("main").setValue(userClass);
    arguments.get("options").setValue("-cp " + quote(classpath));
    return connector.launch(arguments);
  }

  private static String quote(String value) {
    return "\"" + value.replace("\"", "\\\"") + "\"";
  }

  private static int sourceLine(int line) {
    return line > importInsertionLine ? line - syntheticImportCount : line;
  }

  private static String snapshot(
      int step,
      ThreadReference thread,
      Location location,
      String stdout,
      String stderr,
      String eventType,
      Value returnValue,
      boolean hasReturnValue
  ) throws Exception {
    HeapCapture capture = new HeapCapture();
    Integer line = location.lineNumber() > 0 ? sourceLine(location.lineNumber()) : null;
    String returnValueJson = hasReturnValue ? capture.value(returnValue) : null;
    StringBuilder json = new StringBuilder();
    json.append("{\"step\":").append(step)
        .append(",\"event\":").append(string(eventType)).append(",\"line\":")
        .append(line == null ? "null" : line)
        .append(",\"frame\":{\"method\":").append(string(location.method().name()))
        .append(",\"class\":").append(string(location.declaringType().name())).append("}")
        .append(",\"stack\":[");
    List<StackFrame> frames = thread.frames();
    int count = Math.min(frames.size(), MAX_STACK);
    int firstFrame = frames.size() - count;
    for (int index = frames.size() - 1; index >= firstFrame; index--) {
      if (index < frames.size() - 1) json.append(',');
      appendFrame(json, frames.get(index), capture);
    }
    json.append("],\"stackTruncated\":").append(Math.max(0, frames.size() - count));
    if (hasReturnValue) json.append(",\"returnValue\":").append(returnValueJson);
    json
        .append(",\"statics\":").append(appendStatics(location.declaringType(), capture))
        .append(",\"heap\":").append(capture.json())
        .append(",\"stdout\":").append(string(stdout))
        .append(",\"stderr\":").append(string(stderr)).append(",\"changed\":[]")
        .append(",\"explanation\":").append(string(eventType.equals("return")
            ? "Returned from " + location.declaringType().name() + "." + location.method().name()
                + (hasReturnValue ? " with a value" : "")
                + (line == null ? "." : " at line " + line + ".")
            : "Executing " + location.declaringType().name() + "." + location.method().name() + " at line " + line + "."))
        .append(",\"error\":null}");
    return json.toString();
  }

  private static void appendFrame(StringBuilder json, StackFrame frame, HeapCapture capture) throws Exception {
    Location location = frame.location();
    json.append("{\"method\":").append(string(location.method().name()))
        .append(",\"class\":").append(string(location.declaringType().name()))
        .append(",\"line\":").append(sourceLine(location.lineNumber()))
        .append(",\"locals\":{");
    try {
      List<com.sun.jdi.LocalVariable> variables = frame.visibleVariables();
      Map<com.sun.jdi.LocalVariable, Value> values = frame.getValues(variables);
      boolean first = true;
      for (com.sun.jdi.LocalVariable variable : variables) {
        if (!first) json.append(',');
        first = false;
        json.append(string(variable.name())).append(':').append(capture.value(values.get(variable)));
      }
    } catch (com.sun.jdi.AbsentInformationException ignored) {
      // Compiled code without local-variable metadata has an empty locals view.
    }
    json.append("}}");
  }

  private static String appendStatics(ReferenceType type, HeapCapture capture) {
    if (!(type instanceof com.sun.jdi.ClassType classType)) return "{}";
    StringBuilder json = new StringBuilder("{");
    boolean first = true;
    for (Field field : type.allFields()) {
      if (!field.isStatic()) continue;
      if (!first) json.append(',');
      first = false;
      json.append(string(type.name() + "." + field.name())).append(':')
          .append(capture.value(classType.getValue(field)));
    }
    return json.append('}').toString();
  }

  private static final class HeapCapture {
    private static final int MAX_OBJECTS = 500;
    private final Map<Long, String> objects = new LinkedHashMap<>();
    private final java.util.Set<Long> visiting = new java.util.HashSet<>();

    String value(Value value) {
      return value(value, 0);
    }

    private String value(Value value, int depth) {
      if (value == null) return "{\"kind\":\"null\"}";
      if (value instanceof PrimitiveValue primitive) {
        String text = primitive.toString();
        String type = primitive.type().name();
        return "{\"kind\":\"prim\",\"type\":" + string(type) + ",\"value\":" + scalar(text, type) + "}";
      }
      if (value instanceof ObjectReference reference) {
        String id = OBJECT_IDS.computeIfAbsent(reference.uniqueID(), ignored -> "o" + nextObjectId++);
        capture(reference, depth);
        return "{\"kind\":\"ref\",\"id\":" + string(id) + "}";
      }
      return "{\"kind\":\"uninitialized\"}";
    }

    private void capture(ObjectReference reference, int depth) {
      long uniqueId = reference.uniqueID();
      if (objects.containsKey(uniqueId) || visiting.contains(uniqueId)) return;
      if (objects.size() >= MAX_OBJECTS) return;
      String id = OBJECT_IDS.get(uniqueId);
      visiting.add(uniqueId);
      objects.put(uniqueId, "{\"id\":" + string(id) + ",\"type\":" + string(reference.referenceType().name()) + ",\"kind\":\"object\",\"fields\":{},\"size\":0}");
      String object;
      if (reference instanceof ArrayReference array) {
        StringBuilder elements = new StringBuilder("[");
        int count = Math.min(array.length(), 50);
        for (int index = 0; index < count; index++) {
          if (index > 0) elements.append(',');
          elements.append(value(array.getValue(index), depth + 1));
        }
        elements.append(']');
        object = "{\"id\":" + string(id) + ",\"type\":" + string(reference.referenceType().name()) + ",\"kind\":\"array\",\"elements\":" + elements + ",\"size\":" + array.length() + (array.length() > count ? ",\"truncated\":true" : "") + "}";
      } else if (reference instanceof StringReference text) {
        object = "{\"id\":" + string(id) + ",\"type\":\"String\",\"kind\":\"string\",\"elements\":[{\"kind\":\"prim\",\"type\":\"string\",\"value\":" + string(text.value()) + "}],\"size\":" + text.value().length() + "}";
      } else if (isHiddenPlatformType(reference.referenceType().name())) {
        object = "{\"id\":" + string(id) + ",\"type\":" + string(reference.referenceType().name()) + ",\"kind\":\"object\",\"fields\":{},\"size\":0,\"truncated\":true}";
      } else {
        StringBuilder fields = new StringBuilder("{");
        boolean first = true;
        int count = 0;
        for (Field field : reference.referenceType().allFields()) {
          if (field.isStatic() || count >= 50) continue;
          if (!first) fields.append(',');
          first = false;
          fields.append(string(field.name())).append(':').append(value(reference.getValue(field), depth + 1));
          count++;
        }
        fields.append('}');
        object = "{\"id\":" + string(id) + ",\"type\":" + string(reference.referenceType().name()) + ",\"kind\":\"object\",\"fields\":" + fields + ",\"size\":" + count + (count >= 50 ? ",\"truncated\":true" : "") + "}";
      }
      objects.put(uniqueId, object);
      visiting.remove(uniqueId);
    }

    private boolean isHiddenPlatformType(String type) {
      if (type.equals("java.util.Scanner")) return true;
      if (type.startsWith("java.util.")) return false;
      if (type.startsWith("java.math.")) return false;
      if (java.util.Set.of(
          "java.lang.Boolean",
          "java.lang.Byte",
          "java.lang.Character",
          "java.lang.Double",
          "java.lang.Float",
          "java.lang.Integer",
          "java.lang.Long",
          "java.lang.Short"
      ).contains(type)) return false;
      return type.startsWith("java.")
          || type.startsWith("javax.")
          || type.startsWith("jdk.");
    }

    String json() {
      StringBuilder result = new StringBuilder("{");
      boolean first = true;
      for (Map.Entry<Long, String> entry : objects.entrySet()) {
        if (!first) result.append(',');
        first = false;
        result.append(string(OBJECT_IDS.get(entry.getKey()))).append(':').append(entry.getValue());
      }
      return result.append('}').toString();
    }
  }

  private static String scalar(String value, String type) {
    if (type.equals("boolean")) return value;
    if (type.equals("byte") || type.equals("short") || type.equals("int") || type.equals("long") || type.equals("float") || type.equals("double")) return value;
    return string(value);
  }

  private static String string(String value) {
    StringBuilder result = new StringBuilder("\"");
    for (char character : value.toCharArray()) {
      switch (character) {
        case '\\' -> result.append("\\\\");
        case '"' -> result.append("\\\"");
        case '\n' -> result.append("\\n");
        case '\r' -> result.append("\\r");
        case '\t' -> result.append("\\t");
        default -> {
          if (character < 32) result.append(String.format("\\u%04x", (int) character));
          else result.append(character);
        }
      }
    }
    return result.append('"').toString();
  }

  private static final class StreamBuffer extends Thread {
    private final InputStream input;
    private final StringBuilder buffer = new StringBuilder();

    StreamBuffer(InputStream input) { this.input = input; }

    @Override public void run() {
      try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
        String line;
        while ((line = reader.readLine()) != null) synchronized (buffer) { buffer.append(line).append('\n'); }
      } catch (IOException ignored) { }
    }

    String take() { synchronized (buffer) { String value = buffer.toString(); buffer.setLength(0); return value; } }
  }
}
