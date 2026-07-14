import * as SecureStore from "expo-secure-store";
import type { Approval } from "@mayi/contracts";

const ORIGIN = "mayi.origin"; const TOKEN = "mayi.session";
export async function credentials() { return { origin: await SecureStore.getItemAsync(ORIGIN), token: await SecureStore.getItemAsync(TOKEN) }; }
export async function saveCredentials(origin: string, token: string) { await SecureStore.setItemAsync(ORIGIN, origin); await SecureStore.setItemAsync(TOKEN, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }); }
export async function clearCredentials() { await SecureStore.deleteItemAsync(TOKEN); }
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { origin, token } = await credentials(); if (!origin || !token) throw new Error("Not signed in");
  const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${token}`); if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, origin), { ...init, headers }); if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { statusMessage?: string }).statusMessage ?? "Request failed"); return response.json() as Promise<T>;
}
export const approvals = () => request<Approval[]>("/api/approvals");
export const approval = (id: string) => request<Approval>(`/api/approvals/${id}`);
export const decide = (id: string, decision: "APPROVED" | "DENIED", comment?: string) => request<Approval>(`/api/approvals/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, ...(comment ? { comment } : {}) }) });
