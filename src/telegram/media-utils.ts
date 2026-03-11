/**
 * Media utilities for Telegram
 * Handles downloading and encoding media for Claude vision
 */

import type { TelegramClient, Api } from "telegram";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Telegram");

export interface EncodedMedia {
  base64: string;
  mimeType: string;
  size: number;
}

// Maximum image size for Claude API (5MB)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

// Supported image MIME types for Claude
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * Download media from a Telegram message and encode it as base64
 * Returns null if media is not a supported image type or too large
 */
export async function downloadAndEncodeMedia(
  client: TelegramClient,
  message: Api.Message
): Promise<EncodedMedia | null> {
  try {
    // Determine MIME type
    let mimeType = "image/jpeg"; // Default for photos

    if (message.photo) {
      mimeType = "image/jpeg";
    } else if (message.document) {
      const doc = message.document as Api.Document;
      mimeType = doc.mimeType || "application/octet-stream";

      // Check if it's a supported image type
      if (!SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
        log.info(`Skipping unsupported media type: ${mimeType}`);
        return null;
      }

      // Check file size
      const size = Number(doc.size);
      if (size > MAX_IMAGE_SIZE) {
        log.info(`Skipping large file: ${(size / 1024 / 1024).toFixed(2)}MB > 5MB limit`);
        return null;
      }
    } else if (message.video || message.audio || message.voice || message.sticker) {
      // Video, audio, voice, sticker - not supported for vision
      log.info("Skipping non-image media type");
      return null;
    } else {
      return null;
    }

    // Download the media
    const buffer = await client.downloadMedia(message, {});

    if (!buffer) {
      log.info("Failed to download media");
      return null;
    }

    // Convert to Buffer if needed
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    // Check size after download
    if (data.length > MAX_IMAGE_SIZE) {
      log.info(`Downloaded file too large: ${(data.length / 1024 / 1024).toFixed(2)}MB`);
      return null;
    }

    // Encode as base64
    const base64 = data.toString("base64");

    log.info(`Encoded ${mimeType} image: ${(data.length / 1024).toFixed(1)}KB`);

    return {
      base64,
      mimeType,
      size: data.length,
    };
  } catch (error) {
    log.error({ err: error }, "Error downloading media");
    return null;
  }
}
