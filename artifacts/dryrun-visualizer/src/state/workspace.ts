import { create } from 'zustand';

type WorkspaceState = {
  code: string;
  stdin: string;
  activeIndex: number;
  playing: boolean;
  speed: number;
  setCode: (code: string) => void;
  setStdin: (stdin: string) => void;
  setActiveIndex: (index: number) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
};

const starter = `public class Main {
    static int factorial(int n) {
        if (n <= 1) return 1;
        return n * factorial(n - 1);
    }

    public static void main(String[] args) {
        int answer = factorial(4);
        System.out.println(answer);
    }
}`;

export const useWorkspace = create<WorkspaceState>((set) => ({
  code: starter,
  stdin: '',
  activeIndex: 0,
  playing: false,
  speed: 1,
  setCode: (code) => set({ code }),
  setStdin: (stdin) => set({ stdin }),
  setActiveIndex: (activeIndex) => set({ activeIndex }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
}));