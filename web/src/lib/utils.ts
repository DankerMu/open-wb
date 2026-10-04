import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并类名：`clsx` 展开条件写法，`tailwind-merge` 让后写的 Tailwind 类覆盖先写的同组类。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
