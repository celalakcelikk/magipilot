import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const NONCE = 'MPNONCE-0123456789ab';

async function readAll(
  response: vscode.LanguageModelChatResponse,
  onPart?: (count: number) => void,
): Promise<string[]> {
  const parts: string[] = [];
  for await (const part of response.text) {
    parts.push(part);
    onPart?.(parts.length);
  }
  return parts;
}

describe('Magipilot Faz 0 prototype', () => {
  it('registers the three echo models under the magipilot vendor', async () => {
    const models = await vscode.lm.selectChatModels({ vendor: 'magipilot' });
    assert.deepEqual(models.map((m) => m.id).sort(), [
      'magipilot-echo',
      'magipilot-echo-slow',
      'magipilot-echo-tools',
    ]);
    const extension = vscode.extensions.getExtension('celalakcelikk.magipilot');
    assert.ok(extension?.isActive, 'extension should be active after the model lookup');
  });

  it('round-trips a request through the echo model with the request marker', async () => {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'magipilot', id: 'magipilot-echo' });
    assert.ok(model);
    const source = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(`hello ${NONCE}`)],
      {},
      source.token,
    );
    const text = (await readAll(response)).join('');
    assert.equal(text, `magipilot-probe-ok:${NONCE}`);
  });

  it('stops streaming the slow echo model when the request is cancelled', async () => {
    const [model] = await vscode.lm.selectChatModels({
      vendor: 'magipilot',
      id: 'magipilot-echo-slow',
    });
    assert.ok(model);
    const source = new vscode.CancellationTokenSource();
    const startedAt = Date.now();
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User('slow please')],
      {},
      source.token,
    );
    let parts: string[] = [];
    try {
      parts = await readAll(response, (count) => {
        if (count === 2) source.cancel();
      });
    } catch (err) {
      // Cancellation may surface as an error from the stream; that is an acceptable outcome.
      assert.ok(err instanceof Error);
    }
    assert.ok(parts.length < 20, `expected fewer than 20 parts, got ${parts.length}`);
    assert.ok(Date.now() - startedAt < 3000, 'cancellation should end the stream quickly');
    const deadline = Date.now() + 2000;
    let inFlight = await vscode.commands.executeCommand<number>('_magipilot.spike.inFlight');
    while (inFlight !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight = await vscode.commands.executeCommand<number>('_magipilot.spike.inFlight');
    }
    assert.equal(inFlight, 0);
  });
});
