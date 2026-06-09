import {
  AudioClip,
  AudioTrack,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ClipExportInfo {
  name: string;
  fileName: string;
  filePath: string;
}

interface DialogPayload {
  trackName: string;
  folderPath: string;
  clips: ClipExportInfo[];
}

interface DialogResult {
  action: "browse" | "cancel" | "export";
  folderPath?: string;
}

function getExtensionRoot(): string {
  return path.join(__dirname, "..");
}

function getLastFolderPathFile(storageDirectory: string | undefined): string | undefined {
  return storageDirectory ? path.join(storageDirectory, "last-export-folder.txt") : undefined;
}

async function readLastFolderPath(
  storageDirectory: string | undefined,
): Promise<string> {
  const filePath = getLastFolderPathFile(storageDirectory);
  if (!filePath) {
    return "";
  }

  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

async function writeLastFolderPath(
  storageDirectory: string | undefined,
  folderPath: string,
): Promise<void> {
  const filePath = getLastFolderPathFile(storageDirectory);
  if (!filePath) {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, folderPath, "utf8");
}

function sanitizeFileName(name: string): string {
  const sanitized = name.replace(/[/\\?%*:|"<>]/g, "-").trim();
  return sanitized || "clip";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniqueDestinationPath(
  directory: string,
  baseName: string,
  extension: string,
): Promise<string> {
  let candidate = path.join(directory, `${baseName}${extension}`);
  let index = 1;

  while (await pathExists(candidate)) {
    candidate = path.join(directory, `${baseName} (${index})${extension}`);
    index += 1;
  }

  return candidate;
}

async function chooseFolder(): Promise<string | null> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Select export destination")',
      ]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  if (process.platform === "win32") {
    try {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        '$dialog.Description = "Select export destination"; ' +
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { " +
        "Write-Output $dialog.SelectedPath" +
        "}";
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        script,
      ]);
      const selected = stdout.trim();
      return selected ? `${selected}\\` : null;
    } catch {
      return null;
    }
  }

  return null;
}

function collectSessionAudioClips(track: AudioTrack<"1.0.0">): ClipExportInfo[] {
  const clips: ClipExportInfo[] = [];

  for (const slot of track.clipSlots) {
    const clip = slot.clip;
    if (!(clip instanceof AudioClip)) {
      continue;
    }

    const filePath = clip.filePath;
    if (!filePath) {
      continue;
    }

    clips.push({
      name: clip.name,
      fileName: path.basename(filePath),
      filePath,
    });
  }

  return clips;
}

function buildDialogUrl(payload: DialogPayload): string {
  const dialogPath = path.join(getExtensionRoot(), "ui", "export-dialog.html");
  const baseUrl = pathToFileURL(dialogPath).href;
  const data = encodeURIComponent(JSON.stringify(payload));
  return `${baseUrl}?data=${data}`;
}

async function showExportDialog(
  context: ExtensionContext<"1.0.0">,
  payload: DialogPayload,
): Promise<DialogResult> {
  const result = await context.ui.showModalDialog(buildDialogUrl(payload), 520, 420);
  return JSON.parse(result) as DialogResult;
}

async function pickDestinationFolder(
  context: ExtensionContext<"1.0.0">,
  track: AudioTrack<"1.0.0">,
  clips: ClipExportInfo[],
): Promise<string | null> {
  let folderPath =
    (await readLastFolderPath(context.environment.storageDirectory)) || "";

  while (true) {
    const result = await showExportDialog(context, {
      trackName: track.name,
      folderPath,
      clips,
    });

    if (result.action === "cancel") {
      return null;
    }

    if (result.action === "browse") {
      const selected = await chooseFolder();
      if (selected) {
        folderPath = selected;
      } else {
        folderPath = result.folderPath ?? folderPath;
      }
      continue;
    }

    if (result.action === "export" && result.folderPath) {
      await writeLastFolderPath(
        context.environment.storageDirectory,
        result.folderPath,
      );
      return result.folderPath;
    }
  }
}

async function exportClips(
  context: ExtensionContext<"1.0.0">,
  clips: ClipExportInfo[],
  destinationFolder: string,
): Promise<number> {
  await mkdir(destinationFolder, { recursive: true });

  let exported = 0;

  await context.ui.withinProgressDialog(
    "Exporting clips…",
    { progress: 0 },
    async (update, signal) => {
      for (let index = 0; index < clips.length; index += 1) {
        if (signal.aborted) {
          return;
        }

        const clip = clips[index];
        const progress = Math.round(((index + 1) / clips.length) * 100);
        await update(`Exporting "${clip.name}"…`, progress);

        const extension = path.extname(clip.filePath) || ".wav";
        const baseName = sanitizeFileName(clip.name);
        const destinationPath = await uniqueDestinationPath(
          destinationFolder,
          baseName,
          extension,
        );

        await copyFile(clip.filePath, destinationPath);
        exported += 1;
      }

      await update(`Exported ${exported} clip${exported === 1 ? "" : "s"}.`, 100);
    },
  );

  return exported;
}

export async function exportClipsByName(
  context: ExtensionContext<"1.0.0">,
  handle: Handle,
): Promise<void> {
  const track = context.getObjectFromHandle(handle, AudioTrack);
  const clips = collectSessionAudioClips(track);
  const destinationFolder = await pickDestinationFolder(context, track, clips);
  if (!destinationFolder || clips.length === 0) {
    return;
  }

  await exportClips(context, clips, destinationFolder);
}
