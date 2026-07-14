import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
export default function Layout() { return <><StatusBar style="auto" /><Stack screenOptions={{ headerTintColor: "#176b51", contentStyle: { backgroundColor: "#f4f6f3" } }}><Stack.Screen name="index" options={{ title: "May I?" }} /><Stack.Screen name="login" options={{ title: "Sign in" }} /><Stack.Screen name="approval/[id]" options={{ title: "Approval" }} /></Stack></>; }
