# Third-party components

Fast Page Chatのソースコードは [MIT License](LICENSE) で提供します。第三者のソフトウェアやサービスには、それぞれの利用条件が適用されます。

| 構成要素 | 用途 | ライセンス・参照先 |
| --- | --- | --- |
| Node.js | WindowsヘルパーのJavaScript実行環境 | [Node.jsのLICENSE](https://github.com/nodejs/node/blob/main/LICENSE)。Node.js本体および含まれる第三者コンポーネントの通知を、配布する正確なバージョンから同梱する。 |
| OpenAI Codex CLI | Codex App Serverとの接続 | [CodexのLICENSE](https://github.com/openai/codex/blob/main/LICENSE)と、配布する正確なバージョンの第三者通知を確認・同梱する。 |
| Playwright | 開発時のブラウザ検証 | [PlaywrightのLICENSE](https://github.com/microsoft/playwright/blob/main/LICENSE)。拡張機能の実行時には不要。 |
| sharp | 開発時の画像素材生成 | [sharpのLICENSE](https://github.com/lovell/sharp/blob/main/LICENSE)。配下の画像ライブラリはそれぞれの通知も参照。拡張機能の実行時には不要。 |

ソース配布コマンドは実行バイナリを含めません。Windowsの実行ファイルを配布する前に、ビルドに使用した各配布物のバージョン・チェックサム・ライセンスファイルを保存し、必要なライセンスと通知が配布物に入っていることを確認します。リンクだけでは同梱義務を満たしたものとして扱いません。

0.10.0のWindowsビルドは `installer/runtime-lock.json` に固定したNode.js 22.23.3とCodex CLI 0.157.0を使用します。Node.jsの配布アーカイブ内のLICENSEと、`installer/licenses/CODEX-LICENSE.txt`・`CODEX-NOTICE.txt`をヘルパーの `licenses/` へ同梱します。

OpenAIのモデル、API、ChatGPTアカウントにはOpenAIのサービス利用条件が別途適用されます。Fast Page ChatのMIT Licenseが外部サービスの利用権や第三者のページ・画像の利用権を付与するものではありません。
