type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

let space = "";

/** The space the app is showing; every space call goes to it. */
export const setSpace = (id: string) => {
  space = id;
};
export const currentSpace = () => space;
export const spacePath = (path: string) => `/api/s/${space}${path}`;

async function send<T>(url: string, method: Method, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401) window.dispatchEvent(new Event("signed-out"));
  if (!response.ok) throw new Error(data?.error ?? data?.message ?? response.statusText);
  return data as T;
}

/** A call to the current space's API. */
export const api = <T = unknown>(method: Method, path: string, body?: unknown) =>
  send<T>(spacePath(path), method, body);

/** A call about the account itself: who you are and your spaces. */
export const accountApi = <T = unknown>(method: Method, path: string, body?: unknown) =>
  send<T>(`/api${path}`, method, body);

export const socketUrl = (path: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${spacePath(path)}`;

/** Streams a file into the workspace without loading it into memory. */
export async function uploadFile(path: string, file: File) {
  const response = await fetch(spacePath(`/files/upload?path=${encodeURIComponent(path)}`), {
    method: "PUT",
    headers: { "x-savin-upload": "1", "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? response.statusText);
  return (data as { path: string }).path;
}

/** Sends a voice recording as it is and returns the words in it. */
export async function transcribe(recording: Blob, signal: AbortSignal) {
  const response = await fetch(spacePath("/voice/transcribe"), {
    method: "POST",
    headers: { "x-savin-upload": "1", "content-type": recording.type || "application/octet-stream" },
    body: recording,
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? response.statusText);
  return String((data as { text?: string }).text ?? "");
}

export const fileUrl = (path: string, download = false) =>
  spacePath(`/files/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`);
