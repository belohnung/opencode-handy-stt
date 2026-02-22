// OpenCode plugin: Speech-to-text via Handy API.
// Registers a /dictate command that records speech, transcribes it via Handy,
// and appends the result to the OpenCode prompt input.

import type { Plugin } from "@opencode-ai/plugin"

const HANDY_PORT = 9876
const HANDY_API = `http://localhost:${HANDY_PORT}`
const TRANSCRIBE_TIMEOUT_MS = 30_000
const POST_PROCESS_WAIT_MS = 15_000
const POLL_INTERVAL_MS = 300

/** Simple fetch wrapper for Handy REST API. */
async function handyGet<T>(path: string): Promise<T> {
  const res = await fetch(`${HANDY_API}${path}`)
  if (!res.ok) throw new Error(`Handy API error: ${res.status} ${res.statusText}`)
  const json = (await res.json()) as { ok: boolean; data: T; error?: string }
  if (!json.ok) throw new Error(`Handy API error: ${json.error}`)
  return json.data
}

async function handyPost(path: string, body?: Record<string, unknown>): Promise<void> {
  const init: RequestInit = { method: "POST" }
  if (body) {
    init.headers = { "Content-Type": "application/json" }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${HANDY_API}${path}`, init)
  if (!res.ok) throw new Error(`Handy API error: ${res.status} ${res.statusText}`)
  const json = (await res.json()) as { ok: boolean; error?: string }
  if (!json.ok) throw new Error(`Handy API error: ${json.error}`)
}

/** Poll Handy history until a new entry appears, or timeout. */
async function pollForNewEntry(previousId: number, timeoutMs: number): Promise<HistoryEntry> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entry = await getLatestHistory()
    if (entry && entry.id !== previousId && entry.transcription_text) {
      // Entry appeared -- give post-processing extra time to finish
      if (!entry.post_processed_text) {
        const ppDeadline = Date.now() + POST_PROCESS_WAIT_MS
        while (Date.now() < ppDeadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          const updated = await getLatestHistory()
          if (updated?.id === entry.id && updated.post_processed_text) {
            return updated
          }
        }
      }
      return entry
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error("Timed out waiting for transcription")
}

type HistoryEntry = {
  id: number
  transcription_text: string
  post_processed_text?: string
}

/** Fetch the latest history entry from Handy (returned newest-first). */
async function getLatestHistory(): Promise<HistoryEntry | undefined> {
  const data = await handyGet<HistoryEntry[]>("/api/history")
  return data?.[0]
}

/** Show a toast notification, swallowing errors if TUI is unavailable. */
async function toast(
  client: any,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
  title?: string,
): Promise<void> {
  try {
    await client.tui.showToast({
      body: { title, message, variant },
    })
  } catch {
    // TUI may not be available
  }
}

/** Build a context string from the current project state for LLM post-processing. */
async function gatherContext(client: any): Promise<string> {
  const parts: string[] = []

  try {
    const branch = await client.vcs.get()
    if (branch?.data?.branch) {
      parts.push(`Current branch: ${branch.data.branch}`)
    }
  } catch {
    // VCS info unavailable
  }

  try {
    const status = await client.file.status()
    const files: string[] = status?.data?.map((f: any) => f.path).filter(Boolean) ?? []
    if (files.length > 0) {
      parts.push(`Recently modified files:\n${files.map((f: string) => `- ${f}`).join("\n")}`)
    }
  } catch {
    // File status unavailable
  }

  return parts.join("\n")
}

export const DictatePlugin: Plugin = async ({ client }) => {
  let isRecording = false
  let beforeId = 0

  return {
    config: async (config) => {
      config.command ??= {}
      config.command["dictate"] = {
        template: "/dictate",
        description: "Speech-to-text: start/stop recording via Handy",
      }
    },

    "command.execute.before": async (input) => {
      if (input.command !== "dictate") return

      // If already recording, stop and transcribe with post-processing
      if (isRecording) {
        await toast(client, "Stopping recording...", "info", "Dictate")

        try {
          const context = await gatherContext(client)
          await handyPost("/api/transcription/toggle-post-process", context ? { context } : undefined)
          isRecording = false
        } catch (err: any) {
          await toast(client, `Failed to stop recording: ${err.message}`, "error", "Dictate")
          // Keep isRecording=true so user can retry /dictate to stop
          // TODO: replace with proper handled return once plugin SDK supports it
          throw new Error("__DICTATE_HANDLED__")
        }

        await toast(client, "Transcribing...", "info", "Dictate")

        try {
          const entry = await pollForNewEntry(beforeId, TRANSCRIBE_TIMEOUT_MS)
          const text = entry.post_processed_text || entry.transcription_text
          await client.tui.appendPrompt({ body: { text } })
          await toast(client, "Transcription added to prompt", "success", "Dictate")
        } catch (err: any) {
          await toast(client, `Transcription failed: ${err.message}`, "error", "Dictate")
        }

        // TODO: replace with proper handled return once plugin SDK supports it
        throw new Error("__DICTATE_HANDLED__")
      }

      // Not recording -- start recording
      try {
        await handyGet<{ status: string }>("/api/health")
      } catch {
        await toast(
          client,
          `Cannot reach Handy at ${HANDY_API}\nMake sure Handy is running with API enabled`,
          "error",
          "Dictate",
        )
        // TODO: replace with proper handled return once plugin SDK supports it
        throw new Error("__DICTATE_HANDLED__")
      }

      // Snapshot latest history ID and start recording
      try {
        const entry = await getLatestHistory()
        beforeId = entry?.id ?? 0

        await handyPost("/api/transcription/toggle-post-process")
        isRecording = true
        await toast(client, "Recording... run /dictate again to stop", "info", "Dictate")
      } catch (err: any) {
        await toast(client, `Failed to start recording: ${err.message}`, "error", "Dictate")
      }

      // TODO: replace with proper handled return once plugin SDK supports it
      throw new Error("__DICTATE_HANDLED__")
    },
  }
}
