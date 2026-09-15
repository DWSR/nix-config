import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";

type ToolResultBlock = TextContent | ImageContent;

const IMAGE_MAX_BASE64_BYTES = Number(process.env.PI_IMAGE_MAX_BYTES ?? 512 * 1024);
const IMAGE_JPEG_QUALITY = Number(process.env.PI_IMAGE_JPEG_QUALITY ?? 80);

export async function optimizeToolResultImages(
  content: ToolResultBlock[],
): Promise<{ content: ToolResultBlock[] } | undefined> {
  if (!Array.isArray(content) || !content.some((block) => block.type === "image")) return undefined;

  const output: ToolResultBlock[] = [];
  let changed = false;

  for (const block of content) {
    if (block.type !== "image" || block.data.length <= IMAGE_MAX_BASE64_BYTES) {
      output.push(block);
      continue;
    }

    let resized: Awaited<ReturnType<typeof resizeImage>> = null;
    try {
      resized = await resizeImage(Buffer.from(block.data, "base64"), block.mimeType, {
        maxBytes: IMAGE_MAX_BASE64_BYTES,
        jpegQuality: IMAGE_JPEG_QUALITY,
      });
    } catch {
      resized = null;
    }

    if (!resized) {
      output.push(block);
      continue;
    }

    output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
    if (resized.width !== resized.originalWidth || resized.height !== resized.originalHeight) {
      const note = formatDimensionNote(resized);
      if (note) output.push({ type: "text", text: note });
    }
    changed = true;
  }

  return changed ? { content: output } : undefined;
}
