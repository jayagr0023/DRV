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

export const useWorkspace = create<WorkspaceState>((set) => ({
  code: '',
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