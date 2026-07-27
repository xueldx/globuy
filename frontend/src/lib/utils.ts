import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并条件类名：clsx 处理条件 + tailwind-merge 去重冲突（ragent 同款）。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
