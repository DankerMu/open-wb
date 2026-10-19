/** `scheduler` 不带类型；只声明 `scheduler-drain-setup.ts` 用到的导出。 */
declare module "scheduler" {
  /**
   * `unstable_scheduleCallback` 返回的任务记录。`id` 是内部字段（按排入次序自增），屏障靠它判断两次探针之间
   * 有没有任务入队；版本钉在 web/package.json 的 0.27.0；字段若消失，屏障在每次等待处显式抛错。
   */
  export interface SchedulerTask {
    readonly id: number;
  }
  export const unstable_IdlePriority: number;
  export function unstable_scheduleCallback(priority: number, callback: () => void): SchedulerTask;
  export function unstable_cancelCallback(task: SchedulerTask): void;
}
