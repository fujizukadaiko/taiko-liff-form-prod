# taiko-liff-form-prod
【本番環境用】和太鼓サークルの出欠管理用LINE LIFFフォーム

## stagingの現在の動作

stagingフロントは現在、LINE IDトークンで認証した本人のデータをstaging D1から読み取り、本人向け予定と演奏者ごとの出欠状態をカード表示します。通常起動では、staging Workerの`GET /line/home-summary`と`POST /line/attendance/all`を呼び出し、利用者が明示的に予定単位の保存を行った場合だけ認証済み保存routeを呼び出します。

各予定カードでは、Workerが`home-summary`で判定した予定単位・本人演奏者単位の回答可否を表示します。frontend側では受付条件を再実装しません。

`STAGING_AUTHENTICATED_READ_ONLY`を安全なlegacy停止フラグとして維持し、GAS、管理、未認証の書き込み経路は引き続き停止します。回答可能な本人演奏者には、`STAGING_ATTENDANCE_DRAFT_PREVIEW_ONLY`によるローカル選択UIを表示します。選択内容はページのメモリ内だけに保持され、再読み込みまたは画面を閉じると破棄されます。

`STAGING_AUTHENTICATED_ATTENDANCE_SUBMIT_UI`では、予定単位で変更された本人演奏者だけを`mode: "merge"`として認証済みstaging routeへ送ります。保存クリック時にLIFF IDトークンを取得し、clientからlineIdやmemberIdは送りません。成功レスポンスの後に`attendance/all`を再取得して一致を確認できた場合だけローカルの現在値を確定し、他予定の未保存draftは維持します。

自動retryは行わず、network errorは保存結果不明として扱います。legacy routeやGASへのfallbackはありません。Workerの書き込みゲートは通常未設定で、productionへも未反映です。

## 環境設定

staging固有の公開設定は`env-config.js`へ分離しています。設定には環境名、フロントバージョン、LIFF、Worker、GAS、期待するPages hostname、環境バナー表示を含みます。

起動時に設定全体と現在のhostnameを検証し、staging Pagesの正式hostnameと一致しない場合はLIFF初期化やWorker通信へ進まず停止します。`auth-session.js`は接続先を固定値として持たず、検証済みのWorker URLを起動側から受け取ります。

stagingではページタイトル先頭に`[STAGING]`を付け、画面最上部と保存操作付近に「STAGING／テスト環境」を常時表示します。設定エラー画面やconsoleへLIFF ID、GAS URL、Worker URLなどの実値は出力しません。
