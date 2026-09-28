import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./styles.css";
import "./workbench-modes.css";
import "./mobile.css";

export const metadata: Metadata = {
  title: "映卷 · 小说动态漫改编工作台",
  description: "从原文章节到可追溯动态漫生产资料",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
