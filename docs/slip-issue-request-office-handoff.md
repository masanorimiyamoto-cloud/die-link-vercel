# 伝言: 受領伝票の「すぐ発行」— 事務所PCでやること

2026-11-11 作成・同日更新。受領伝票を発行している事務所PCで作業する人（または Claude）あての伝言です。

## いまの状態

スマホの工程画面（die-link-vercel）の「🧾 受領伝票をすぐ発行」に対応する処理を、`Z:\Airtable\receipt_slip_issue.py` に `--requests` モードとして足しました（別のPCから NAS 上のファイルを直接編集）。

- 元のファイル: `Z:\Airtable\receipt_slip_issue.py.bak_20261111_before_requests`
- 起動用バッチ: `Z:\Airtable\run_receipt_slip_requests.bat`（新規）
- 試験: `Z:\Airtable\test_receipt_slip_requests.py`（作り物の Airtable・Excel・プリンタで10件。本物には繋がない）

確かめたのは、作り物を使った試験と、「依頼が無いときは Airtable を2回読んで終わる」ことの実行までです。**実際の印刷（Excel 16 の台紙・プリンタ・QR・印刷後の同期）は、発行するPCでまだ一度も動かしていません。** 下の手順で確かめてから有効にしてください。

定時の自動発行（`--slot` など）の流れは変えていません。変えたのは `_issue_groups` に省略できる引数 `results` を足した1点だけで、定時発行は渡さないので今までどおりです。

## 事務所PCでやること

1. **ドライランで確かめる。** 受領伝票発行可能の受注を1件、Airtable の `TableSlipIssueRequest` に手で1行作ります（依頼ID `sl-test-00000001`、受注RecordID にその受注の `rec...`、状態 `依頼済`、依頼日時 に今の時刻）。そのうえで次を実行します。

   ```
   \\server\data\Airtable\run_receipt_slip_requests.bat dry
   ```

   PDF が検証用フォルダ（`RECEIPT_SLIP_DRYRUN_DIR`）に出て、依頼の行が `依頼済` のまま変わらないことを確かめます。ログは `receipt_slip_issue.log` の「受領伝票 すぐ発行の依頼」の行です。

2. **本番で1件出す。** 引数なしで同じバッチを実行し、紙が出て、行が `発行済`・伝票ID 入りになり、受注の 進行社外 が `伝票出力済` になることを確かめます。まとめ依頼も、同じ納期・納品先の受注2〜3件で確かめてください（下の「まとめ依頼」の行の形で手で作るか、手順4の後に画面から）。

3. **1分ごとに走らせる。** タスク スケジューラに登録します（工程表のコピー印刷 `run_kotei_copy_print.bat` と同じ形）。

   ```
   schtasks /Create /TN "ReceiptSlipRequests" /TR "\\server\data\Airtable\run_receipt_slip_requests.bat" /SC MINUTE /MO 1 /F
   ```

   **登録するのは1台だけ**にしてください。バッチは新PC用（保存済みの .xls を読む `--source file`）です。旧PC（Excel 2000）で走らせる場合は、`run_receipt_slip.bat` と同じ Python で `receipt_slip_issue.py --requests --real` を呼ぶバッチにします。

4. **画面のボタンを有効にする。** Vercel の環境変数に `SLIP_ISSUE_ENABLED=1` を入れて再デプロイします。これを入れるまで、画面のボタンは「事務所PCの準備がまだ」と断り、依頼の表に何も書きません。

## 依頼の表（画面が書くもの）

表は `TableSlipIssueRequest`（ID `tblfxuQ9I90rGgMYr`、ベース `appwAnJP9OOZ3MVF5`）。1行が受注1件です。

| 欄 | 中身 | 書く人 |
|---|---|---|
| 依頼ID | `sl-` で始まる ID。まとめ依頼の2件目以降は `元の依頼ID.2`、`.3`… | 画面 |
| 受注RecordID | TableJuchu のレコードID（`rec...`） | 画面 |
| 状態 | `依頼済` → `発行中` → `発行済`／`失敗` | 画面は `依頼済` だけ。あとは事務所PC |
| Book / WorkCord / ItemName | 依頼した時点の値（確認用） | 画面 |
| 依頼者 / 社員番号 / 依頼日時 | 押した人と時刻 | 画面 |
| 処理日時 / 伝票ID / 処理メモ | 結果 | 事務所PC |

### まとめ依頼

選んだ受注と Book・顧客（Kname）・納品先（DeliPlace）・納期（Ndate）が同じで、受領伝票発行可能・伝票ID が空の受注があれば、画面は一覧を見せて確認を取り、1回の書き込みでまとめて行を作ります（選んだ受注＋最大9件）。依頼ID は選んだ受注が `sl-xxxx`、ほかが `sl-xxxx.2`、`sl-xxxx.3`…で、依頼日時は全部同じです。

`--requests` は `依頼済` の行を1回の実行で全部拾うので、まとめ依頼の行は一緒に発行されます。

## `--requests` の決まり

- **依頼された受注だけ出します。** 対象は 受注RecordID で決め、納品日の範囲（`--slot`）は見ません。
- **発行の直前に確かめます。** 進行社外が `受領伝票発行可能`、伝票ID が空、アーカイブ済でない、の3つ。外れた受注は出さずに `失敗` にします。
- **1枚の単位は今までどおり** `group_key`（ブック×顧客×納品先×納品日）で、中身は S96.5 から読みます。Excel 側の納品先が違えば、1つの依頼でも2枚に分かれます。
- **揃うまでの保留（`GROUP_HOLD`）は掛けません。** まだ工程の途中の受注があることは、画面が「この伝票に入りません」と見せて確認を取っています。
- **納期か数量が Excel と Airtable で違う受注は出しません**（`失敗`。理由は「同期を待って、もう一度依頼してください」）。画面で数量・納期を直した直後に頼むと、古い値の伝票が出て、印刷後の同期で Airtable まで古い値に戻るためです。
- **早期引取の得意先（ツルオカ紙工）と `EXCLUDE_CUSTOMERS` は対象外**で `失敗` にします。前者は引取日にまとめて引取日の日付で出す決まり、後者は自動では出さないと決めた先だからです。すぐ発行でも出したい場合は `collect_request_targets` の該当の2行を外してください。
- **120分より古い `依頼済` は出しません**（`RECEIPT_SLIP_REQ_MAX_AGE_MIN`）。
- **`発行中` のまま残った行は、次の実行が `失敗` にします。** 発行は受領伝票のロックの中でしか動かないので、ロックを取った時点で `発行中` の行は前の実行が途中で止まったものです。残すと、画面からその受注をもう頼めなくなります。
- **ロックを取れないときは何も変えず、次の回（1分後）に回します。**
- **`--real` が無ければ PDF だけ**で、依頼の表も受注も変えません。

失敗の理由は 処理メモ の最後の行に書きます。画面はその1行を「発行できませんでした：○○」と出します。

### 知っておくこと

印刷の前に受注へ 伝票ID を書く作りは定時発行と同じです。そのため、伝票ID を書いた後で印刷に失敗すると、依頼の行は `失敗` になり、受注には 伝票ID が残ります。この受注は画面からはもう頼めませんが、定時の自動発行が同じ番号で出し直します（ログの「[再発行]」）。

## 関係するファイル

- 事務所側: `Z:\Airtable\receipt_slip_issue.py` の `run_requests`・`collect_request_targets`・`set_request_state`
- 画面: `die-link-vercel/public/process.html` の `renderSlipIssue`・`slRequest`
- サーバー: `die-link-vercel/api/_process.js` の `slipIssue`・`slipMates`・`slipIssueStatus`
- 画面側の試験: `die-link-vercel/tools/process-regression.cjs` の SL1・SL2
