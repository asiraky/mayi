import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges class lists so a caller's utility wins over a component's default. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
