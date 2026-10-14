import { atom } from "@excalidraw/excalidraw/editor-jotai";
export const isLocalAIBackend =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(
    import.meta.env.VITE_APP_AI_BACKEND || "",
  );

export const nativeAIOpenAtom = atom(false);
