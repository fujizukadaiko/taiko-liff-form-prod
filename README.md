# taiko-liff-form-prod
【本番環境用】和太鼓サークルの出欠管理用LINE LIFFフォーム

## stagingの現在の動作

stagingフロントは現在、LINE IDトークンで認証した本人のデータをstaging D1から読み取り、本人向け予定と演奏者ごとの出欠状態をカード表示する読み取り専用モードです。通常起動では、staging Workerの`GET /line/home-summary`と`POST /line/attendance/all`だけを呼び出します。

各予定カードでは、Workerが`home-summary`で判定した予定単位・本人演奏者単位の回答可否を表示します。frontend側では受付条件を再実装しません。

`STAGING_AUTHENTICATED_READ_ONLY`を維持し、サーバー通信上は引き続き読み取り専用です。回答可能な本人演奏者には、`STAGING_ATTENDANCE_DRAFT_PREVIEW_ONLY`によるローカル選択UIを表示します。選択内容はページのメモリ内だけに保持され、再読み込みまたは画面を閉じると破棄されます。

将来の認証済みmerge形式に合わせたpayloadはローカルで生成しますが、送信処理はありません。`POST /line/attendance/submit-authenticated`は未使用で、書き込みゲートも通常未設定です。初回登録、出欠登録・変更、メンバー編集、管理、フィードバック、GAS通信などの書き込み機能は閉鎖しており、productionへも未反映です。
