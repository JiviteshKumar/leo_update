// Copy of the extension's workflow model (../src/utils/types.ts). Kept as a
// deliberate duplicate until the repo grows a shared package — update both
// sides when the step shape changes.

export interface TargetInfo {
  selectors: string[];
  tag: string;
  text?: string;
  intent: string;
  context?: string;
  framePath: string[];
}

export type Step =
  | { type: 'navigate'; url: string }
  | { type: 'nav-wait'; urlHint: string }
  | { type: 'click'; target: TargetInfo }
  | { type: 'dblclick'; target: TargetInfo }
  | { type: 'type'; target: TargetInfo; text: string; secret: boolean }
  | { type: 'select'; target: TargetInfo; value: string; label: string }
  | { type: 'key'; key: 'Enter' | 'Tab' | 'Escape'; target?: TargetInfo }
  | { type: 'download' };

export interface Workflow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  startUrl: string;
  steps: Step[];
  healCount: number;
  objective?: string;
}
