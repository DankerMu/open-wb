// 输入框「锁定」与「生成中」的派生（纯函数，无 React）：`useChatSession` 把页面状态交给它。
type ComposerInputs = {
  /** 本页拥有的创建或提交请求在途。 */
  sending: boolean;
  regenerating: boolean;
  /** 权威状态（最近快照与其后事件）为 running。 */
  running: boolean;
  historyLoading: boolean;
  forking: boolean;
  /** 本页拥有的撤回请求（含其后的快照重读）在途。 */
  undoing: boolean;
  /** 连接器终止失败（刷新指引已显示）。 */
  streamFailed: boolean;
  draft: string;
};

/**
 * 输入框的派生量（design D1）：`generating` 只指回合进行中（发送在途、重新生成在途、权威状态 running），
 * 它驱动 `生成中` 与 `停止`；历史加载中、分叉在途、撤回在途与连接器终止失败只锁定输入框。失败引导优先：连接器
 * 终止失败时即使最近快照仍是 running 也不算 generating。
 */
export function composerLocks(input: ComposerInputs) {
  const turnActive = input.sending || input.regenerating || input.running;
  const composerDisabled =
    turnActive || input.streamFailed || input.historyLoading || input.forking || input.undoing;
  return {
    composerDisabled,
    generating: turnActive && !input.streamFailed,
    sendDisabled: composerDisabled || input.draft.trim().length === 0,
  };
}
