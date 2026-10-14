import { CaptureUpdateAction } from "@excalidraw/element";

import { ExportImageIcon } from "../components/icons";

import { register } from "./register";

export const actionExportDrawio = register({
  name: "exportDrawio",
  label: "labels.exportDrawio",
  icon: ExportImageIcon,
  keywords: [
    "draw.io",
    "drawio",
    "diagrams.net",
    "confluence",
    "xml",
    "export",
  ],
  viewMode: true,
  trackEvent: { category: "export" },
  perform(_elements, appState) {
    return {
      appState: { ...appState, openDialog: { name: "drawioExport" } },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});
