import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { actionName, type Approval } from "@mayi/contracts";
import { approvals, credentials, request } from "../lib/api";

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }) });

export default function Inbox() {
  const [items, setItems] = useState<Approval[]>(); const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => { if (!(await credentials()).token) return router.replace("/login"); try { setItems(await approvals()); const last = await Notifications.getLastNotificationResponseAsync(); const id = last?.notification.request.content.data?.approvalId; if (typeof id === "string") router.push(`/approval/${id}`); } catch { router.replace("/login"); } }, []);
  useFocusEffect(useCallback(() => { void load(); const sub = Notifications.addNotificationResponseReceivedListener((response) => { const id = response.notification.request.content.data?.approvalId; if (typeof id === "string") router.push(`/approval/${id}`); }); return () => sub.remove(); }, [load]));
  useFocusEffect(useCallback(() => { void (async () => { if (!Device.isDevice) return; const permission = await Notifications.requestPermissionsAsync(); if (!permission.granted) return; const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined; if (!projectId || projectId.startsWith("REPLACE")) return; const token = await Notifications.getExpoPushTokenAsync({ projectId }); await request("/api/devices", { method: "POST", body: JSON.stringify({ token: token.data, platform: process.env.EXPO_OS === "ios" ? "ios" : "android" }) }); })(); }, []));
  if (!items) return <ActivityIndicator style={{ flex: 1 }} color="#176b51" />;
  const pending = items.filter((item) => item.state === "PENDING");
  const history = items.filter((item) => !["PENDING", "DRAFT"].includes(item.state));
  return <ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}><Text style={styles.eyebrow}>PENDING APPROVALS</Text>{pending.length === 0 && <Text style={styles.empty}>Nothing is waiting for you.</Text>}{pending.map((item) => <Pressable key={item.id} style={styles.card} onPress={() => router.push(`/approval/${item.id}`)}><View><Text style={styles.kind}>{actionName(item.action)}</Text><Text numberOfLines={2} style={styles.explanation}>{item.explanation}</Text></View><Text style={styles.expiry}>{new Date(item.expiresAt).toLocaleTimeString()}</Text></Pressable>)}<Text style={[styles.eyebrow, { marginTop: 24 }]}>RECENT ACTIVITY</Text>{history.map((item) => <Pressable key={item.id} style={styles.card} onPress={() => router.push(`/approval/${item.id}`)}><View><Text style={styles.kind}>{actionName(item.action)}</Text><Text style={styles.explanation}>{item.state}</Text></View><Text style={styles.expiry}>{new Date(item.decidedAt ?? item.createdAt).toLocaleDateString()}</Text></Pressable>)}</ScrollView>;
}
const styles = StyleSheet.create({ page: { padding: 18, gap: 12 }, eyebrow: { color: "#61776d", fontSize: 12, letterSpacing: 1.4, marginBottom: 4 }, empty: { color: "#61776d", textAlign: "center", marginTop: 80 }, card: { backgroundColor: "white", borderRadius: 14, padding: 17, borderWidth: 1, borderColor: "#dce3df", flexDirection: "row", justifyContent: "space-between", gap: 12 }, kind: { fontSize: 17, fontWeight: "700", color: "#18241f" }, explanation: { color: "#61776d", marginTop: 5, maxWidth: 250 }, expiry: { color: "#755800", fontSize: 12 } });
