import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { saveCredentials } from "../lib/api";

export default function Login() {
  const [origin, setOrigin] = useState("http://localhost:3000"); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  async function submit() { setBusy(true); try { const response = await fetch(new URL("/api/auth/signin", origin), { method: "POST", headers: { "content-type": "application/json", "x-mayi-native": "true" }, body: JSON.stringify({ email, password }) }); const body = await response.json() as { sessionToken?: string; statusMessage?: string }; if (!response.ok || !body.sessionToken) throw new Error(body.statusMessage ?? "Sign in failed"); await saveCredentials(origin, body.sessionToken); router.replace("/"); } catch (error) { Alert.alert("Could not sign in", error instanceof Error ? error.message : "Unknown error"); } finally { setBusy(false); } }
  return <View style={styles.page}><Text style={styles.title}>Connect to May I?</Text><TextInput style={styles.input} value={origin} onChangeText={setOrigin} autoCapitalize="none" keyboardType="url" placeholder="Service URL" /><TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="Email" /><TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="Password" /><Pressable style={styles.button} disabled={busy} onPress={submit}><Text style={styles.buttonText}>{busy ? "Signing in…" : "Sign in"}</Text></Pressable></View>;
}
const styles = StyleSheet.create({ page: { flex: 1, padding: 24, gap: 14, justifyContent: "center" }, title: { fontSize: 28, fontWeight: "700", color: "#18241f" }, input: { borderWidth: 1, borderColor: "#bdcac4", backgroundColor: "white", borderRadius: 10, padding: 14 }, button: { backgroundColor: "#176b51", borderRadius: 10, padding: 15, alignItems: "center" }, buttonText: { color: "white", fontWeight: "700" } });
