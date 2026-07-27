# taiko-liff-form-prod
【本番環境用】和太鼓サークルの出欠管理用LINE LIFFフォーム

## stagingの現在の動作

stagingフロントは現在、LINE IDトークンで認証した本人のデータをstaging D1から読み取り、本人向け予定と演奏者ごとの出欠状態をカード表示します。通常起動では、staging Workerの`GET /line/home-summary`と`POST /line/attendance/all`を呼び出し、利用者が明示的に予定単位の保存を行った場合だけ認証済み保存routeを呼び出します。

各予定カードでは、Workerが`home-summary`で判定した予定単位・本人演奏者単位の回答可否を表示します。frontend側では受付条件を再実装しません。

`STAGING_AUTHENTICATED_READ_ONLY`を安全なlegacy停止フラグとして維持し、GAS、管理、未認証の書き込み経路は引き続き停止します。回答可能な本人演奏者には、`STAGING_ATTENDANCE_DRAFT_PREVIEW_ONLY`によるローカル選択UIを表示します。選択内容はページのメモリ内だけに保持され、再読み込みまたは画面を閉じると破棄されます。

`STAGING_AUTHENTICATED_ATTENDANCE_SUBMIT_UI`では、予定単位で変更された本人演奏者だけを`mode: "merge"`として認証済みstaging routeへ送ります。保存クリック時にLIFF IDトークンを取得し、clientからlineIdやmemberIdは送りません。成功レスポンスの後に`attendance/all`を再取得して一致を確認できた場合だけローカルの現在値を確定し、他予定の未保存draftは維持します。

自動retryは行わず、network errorは保存結果不明として扱います。legacy routeやGASへのfallbackはありません。Workerの書き込みゲートは通常未設定で、productionへも未反映です。

管理者本人にはproduction形式の管理者メニューを表示します。現在有効なのは
「予定登録/編集」「出欠結果一覧」「配車補助」「カスタム通知」「ご意見BOX」です。
いずれも操作時に現在のLIFF IDトークンを取得し、
WorkerでIDトークンとD1の有効管理者ミラーを再確認します。

予定登録・編集は認証済み専用routeを使用し、削除はまだ利用できません。
出欠結果一覧は認証済みの読み取り専用routeを使用し、対象者・未回答・締切をWorkerで
確定します。旧管理画面、query parameterの`lineId`、旧GAS fallbackは使用しません。
配車補助は認証済みの専用読み取りrouteから、Workerが世帯単位へ集約した参加者候補だけを
取得します。LINE IDや内部keyは受け取りません。候補、定員、太鼓車、メモ、追加同行者は
保存せず、画面内だけで計算します。
カスタム通知はWorkerが宛先を再計算して送信待ちへ登録し、ブラウザへLINE IDを返しません。
送信待ち登録とLINE実送信は別結果として表示し、結果不明時は自動再送しません。
ご意見投稿・管理一覧・status更新も認証済みWorker APIだけを使い、ご意見はD1を正本とします。
右下のご意見BOXは登録済み利用者だけに表示します。サマリは現役メニューと画面から廃止しました。
通常の認証成功時は試験用の状態カードを表示せず、production相当のhome shellを
そのまま表示します。未登録・認証失敗・通信失敗・レスポンス不正時だけ、
安全な案内カードを表示します。stagingバナーとバージョン表示は常時維持します。

予定登録・編集画面もproductionのアコーディオン、一覧カード、入力フォーム、
注釈、ボタン配置を表示基準とします。画面用の安全なIDと認証済みWorker通信は
legacy処理から隔離したまま維持し、staging注意表示は一覧内と保存操作付近に残します。

## 環境設定

staging固有の公開設定は`env-config.js`へ分離しています。設定には環境名、フロントバージョン、LIFF、Worker、GAS、期待するPages hostname、環境バナー表示を含みます。

起動時に設定全体と現在のhostnameを検証し、staging Pagesの正式hostnameと一致しない場合はLIFF初期化やWorker通信へ進まず停止します。`auth-session.js`は接続先を固定値として持たず、検証済みのWorker URLを起動側から受け取ります。

stagingではページタイトル先頭に`[STAGING]`を付け、画面最上部と保存操作付近に「STAGING／テスト環境」を常時表示します。設定エラー画面やconsoleへLIFF ID、GAS URL、Worker URLなどの実値は出力しません。
