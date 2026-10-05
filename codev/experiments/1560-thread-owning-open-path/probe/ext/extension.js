// Throwaway probe for experiment 1560 (NOT production code). Registers a
// comment controller shaped like the builder-review one and records which
// thread object each submit/save arrives on, so the runner can check handle
// ownership and duplicate-thread creation.
const vscode = require('vscode');

const events = [];

function activate(context) {
  const controller = vscode.comments.createCommentController('probe-1560', 'Probe 1560');
  controller.options = { prompt: 'Probe comment', placeHolder: 'probe' };
  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      const last = Math.max(0, document.lineCount - 1);
      return { enableFileComments: true, ranges: [new vscode.Range(0, 0, last, 0)] };
    },
  };
  context.subscriptions.push(controller);

  context.subscriptions.push(
    vscode.commands.registerCommand('probe1560.submit', (reply) => {
      events.push({ kind: 'submit', thread: reply.thread, text: reply.text });
    }),
    vscode.commands.registerCommand('probe1560.saveDraft', (comment) => {
      let body = comment.body;
      if (typeof body !== 'string') { body = body.value; }
      events.push({ kind: 'saveDraft', comment, thread: comment.parent, text: body });
    }),
  );

  return { controller, events };
}

module.exports = { activate, deactivate() {} };
