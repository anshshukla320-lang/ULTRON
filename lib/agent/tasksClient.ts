import { getAccessToken } from "./googleAuth";

interface GTask {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: string;
}

async function tasksFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://tasks.googleapis.com/tasks/v1${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Google Tasks API error (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export async function listTasks(maxResults = 20): Promise<string> {
  const params = new URLSearchParams({ maxResults: String(Math.min(maxResults, 100)), showCompleted: "false" });
  const data = await tasksFetch<{ items?: GTask[] }>(`/lists/@default/tasks?${params.toString()}`);
  const items = data.items ?? [];
  if (items.length === 0) return "No open tasks found.";
  return items.map((t) => `[${t.id}] ${t.title ?? "(untitled)"}${t.due ? ` (due ${t.due})` : ""}`).join("\n");
}

export async function createTask(title: string, notes?: string, due?: string): Promise<string> {
  const body: Record<string, string> = { title };
  if (notes) body.notes = notes;
  if (due) body.due = due;
  const task = await tasksFetch<GTask>("/lists/@default/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return `Created task "${task.title}".`;
}

export async function completeTask(taskId: string): Promise<string> {
  const task = await tasksFetch<GTask>(`/lists/@default/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  });
  return `Marked "${task.title}" as completed.`;
}
