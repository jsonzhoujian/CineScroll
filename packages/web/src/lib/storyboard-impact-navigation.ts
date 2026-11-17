import { createContext } from "react";

export type StoryboardImpactTarget = { projectId: string; chapterId: string; reviewId: string; shotId: string };

export const OpenStoryboardImpact = createContext<((target: StoryboardImpactTarget) => void) | null>(null);
