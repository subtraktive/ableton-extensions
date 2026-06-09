import { initialize, type ActivationContext, type Handle } from "@ableton-extensions/sdk";
import { exportClipsByName } from "./exportClipsByName.js";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  void context.ui.registerContextMenuAction(
    "AudioTrack",
    "Export Clips by Name",
    "ExportClipsByName",
  );

  context.commands.registerCommand("ExportClipsByName", (handle) => {
    void exportClipsByName(context, handle as Handle).catch((error: unknown) => {
      console.error("ExportClipsByName failed:", error);
    });
  });
}
