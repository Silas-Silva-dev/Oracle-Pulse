; ============================================================================
;  Oracle Pulse - instalador para Windows (Inno Setup 6.7+)
;
;  NÃO compile este arquivo diretamente: use  installer\build.ps1 , que monta
;  a pasta {#BuildDir} (app + node_modules + Node.js portátil + WinSW) e passa
;  /DAppVersion e /DBuildDir para o ISCC.
;
;  O que o instalador faz:
;   - copia a aplicação e um Node.js portátil (não depende de Node instalado);
;   - pede os dados do .env (obrigatórios: banco Oracle e login do painel);
;     valida tudo ANTES de instalar, com o mesmo código que grava o arquivo;
;   - grava o .env (senha do painel como hash scrypt) com acesso só para
;     Administradores e SYSTEM;
;   - registra e inicia o serviço do Windows "OraclePulse" (WinSW), com
;     início automático e reinício em caso de falha;
;   - libera a porta no Firewall (opcional), confere se o painel responde e
;     testa a conexão com o Oracle.
;  Atualização: executar uma versão nova por cima mantém o .env (ou permite
;  revisá-lo). Instalação silenciosa: veja installer\README.md.
; ============================================================================

#if Ver < EncodeVer(6,3,0)
  #error Este script exige o Inno Setup 6.3 ou mais novo (use installer\build.ps1).
#endif

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef BuildDir
  #define BuildDir "build"
#endif

#define AppName "Oracle Pulse"
#define AppPublisher "Silas Silva"
#define ServiceName "OraclePulse"
#define FirewallRule "Oracle Pulse"

[Setup]
AppId={{8F3C2A51-6B7D-4E0A-9C1E-5D2B7A4F9E31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppComments=Painel de monitoramento e administração do banco Oracle
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription=Instalador do {#AppName}
DefaultDirName={autopf}\OraclePulse
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableWelcomePage=no
; A validação da pasta (ValidateDir) já recusa pastas com outros arquivos.
DirExistsWarning=no
UsePreviousAppDir=yes
UsePreviousTasks=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 10 1607 / Server 2016 ou mais novo (Node.js 24 e .NET 4.6.2 do WinSW)
MinVersion=10.0.14393
WizardStyle=modern
WizardSizePercent=120,130
SetupIconFile=support\OraclePulse.ico
WizardSmallImageFile=support\wizard-small-*.png
WizardImageFile=support\wizard-large-*.png
WizardImageStretch=no
UninstallDisplayIcon={app}\OraclePulse.ico
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
OutputDir=dist
SetupLogging=yes
; O serviço é parado/iniciado pelo próprio script (não pelo Restart Manager).
CloseApplications=no
RestartApplications=no
ShowLanguageDialog=no
#ifdef PREVIEW
; Build de pré-visualização (só para capturar as telas): não instala nada.
PrivilegesRequired=lowest
OutputBaseFilename=OraclePulse-Setup-{#AppVersion}-PREVIEW
#else
PrivilegesRequired=admin
OutputBaseFilename=OraclePulse-Setup-{#AppVersion}
#endif

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Messages]
brazilianportuguese.WelcomeLabel2=Este assistente vai instalar o [name/ver] neste computador como um serviço do Windows.%n%nTenha em mãos os dados de conexão com o banco Oracle (host, porta, service name, usuário e senha) e defina a senha de acesso ao painel.%n%nO Node.js necessário já está incluído; nada mais precisa ser instalado.

[Tasks]
Name: "firewall"; Description: "Liberar a porta do painel no Firewall do Windows (acesso pela rede)"
Name: "desktopicon"; Description: "Criar atalho do painel na Área de Trabalho"; Flags: unchecked

[InstallDelete]
; Atualização limpa: remove arquivos da versão anterior (preserva .env e logs).
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\tools"

[Files]
; {#BuildDir}\app espelha exatamente a pasta instalada ({app}).
; Os 4 primeiros vêm no início do bloco comprimido: o assistente os extrai
; (ExtractTemporaryFiles) para validar o .env antes de instalar qualquer coisa.
Source: "{#BuildDir}\app\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "{#BuildDir}\app\tools\configure-env.js"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "{#BuildDir}\app\node_modules\dotenv\package.json"; DestDir: "{app}\node_modules\dotenv"; Flags: ignoreversion
Source: "{#BuildDir}\app\node_modules\dotenv\lib\main.js"; DestDir: "{app}\node_modules\dotenv\lib"; Flags: ignoreversion
Source: "{#BuildDir}\app\*"; Excludes: "\runtime\node.exe,\tools\configure-env.js,\node_modules\dotenv\package.json,\node_modules\dotenv\lib\main.js,\.env,\logs"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "support\OraclePulse.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\logs"

[INI]
Filename: "{app}\Abrir Oracle Pulse.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:GetPanelPort}/"
Filename: "{app}\Abrir Oracle Pulse.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\OraclePulse.ico"
Filename: "{app}\Abrir Oracle Pulse.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{autoprograms}\{#AppName}\Abrir o Oracle Pulse"; Filename: "{app}\Abrir Oracle Pulse.url"; IconFilename: "{app}\OraclePulse.ico"
Name: "{autoprograms}\{#AppName}\Pasta de logs"; Filename: "{app}\logs"
Name: "{autoprograms}\{#AppName}\Desinstalar o Oracle Pulse"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Abrir Oracle Pulse.url"; IconFilename: "{app}\OraclePulse.ico"; Tasks: desktopicon

[Run]
Filename: "http://localhost:{code:GetPanelPort}/"; Description: "Abrir o Oracle Pulse no navegador"; Flags: postinstall shellexec nowait skipifsilent runasoriginaluser; Check: PanelIsUp

[UninstallDelete]
Type: files; Name: "{app}\Abrir Oracle Pulse.url"
Type: files; Name: "{app}\logs\install-status.txt"

[Code]
const
  SERVICE_NAME = '{#ServiceName}';
  FIREWALL_RULE = '{#FirewallRule}';
  MIN_PASSWORD = 6;
  NO_PARAM = '#@NONE@#';

var
  // ---- estado da configuração existente (.env na pasta escolhida) ----
  ExistingEnv: Boolean;
  EnvLoaded: Boolean;
  LoadedForDir: String;
  ExKeys, ExVals: TArrayOfString;

  // ---- páginas e controles ----
  PageKeep, PageDb, PageAuth, PageSsh, PageAdv: TWizardPage;
  RbKeep, RbEdit: TNewRadioButton;
  KeepInfo: TNewStaticText;
  CbDemo: TNewCheckBox;
  DemoPrefill, DemoFromParam: Boolean;
  EdAuthPass2: TNewEdit;
  LbDbPassHint, LbAuthPassHint, LbSshPassHint, LbSysPassHint: TNewStaticText;

  // ---- registro dos campos do .env ----
  FKeys, FParams, FDefaults, FPrefill: TArrayOfString;
  FEdits: array of TNewEdit;
  FSecret, FFromParam: array of Boolean;

  // ---- validação e resultado da instalação ----
  ToolsExtracted, DryRunPassed: Boolean;
  PanelPort: String;
  DemoMode, ConfigOk, ServiceOk, HttpOk: Boolean;
  DbStatus, DbMessage, ConfigMessage, FinishWarnings: String;
  RemoveDataOnUninstall: Boolean;

  // ---- senha de instalação diária ----
  PagePwd: TInputQueryWizardPage;

// Algoritmo da senha de instalação (IKAccepts/...). Arquivo PRIVADO (contém o
// segredo) e fora do repositório público. Quando ausente, o instalador compila
// SEM o gate de senha (IK_HAS_GATE indefinido) — ver os #ifdef mais abaixo.
#if FileExists(AddBackslash(SourcePath) + "support\install-key.iss")
  #define IK_HAS_GATE
  #include "support\install-key.iss"
#endif

// ============================================================================
// Utilitários gerais
// ============================================================================

function HasParam(const Name: String): Boolean;
begin
  Result := ExpandConstant('{param:' + Name + '|' + NO_PARAM + '}') <> NO_PARAM;
end;

function ParamValue(const Name: String): String;
begin
  Result := ExpandConstant('{param:' + Name + '|}');
end;

function IsTrueText(const S: String): Boolean;
var L: String;
begin
  L := Lowercase(Trim(S));
  Result := (L = '1') or (L = 'true') or (L = 'sim') or (L = 'yes');
end;

// Modo "só conferir a senha": a tela "Sobre" do painel roda o instalador BAIXADO
// com  /VERIFYONLY=1 /INSTALLPWD=<senha> /VERIFYOUT=<arquivo>  apenas para validar
// a senha do dia SEM instalar nada. Grava OK/BAD no arquivo e aborta. Assim o painel
// consegue dar retorno imediato ("senha incorreta") antes de agendar a atualização.
function InitializeSetup(): Boolean;
var OutFile: String;
begin
  Result := True;
  if HasParam('VERIFYONLY') then
  begin
    Result := False;   // neste modo nunca instala
    OutFile := ParamValue('VERIFYOUT');
    if OutFile <> '' then
    begin
#if defined(IK_HAS_GATE) && !defined(PREVIEW)
      if IKAccepts(ParamValue('INSTALLPWD')) then
        SaveStringToFile(OutFile, 'OK', False)
      else
        SaveStringToFile(OutFile, 'BAD', False);
#else
      SaveStringToFile(OutFile, 'NOGATE', False);
#endif
    end;
  end;
end;

function ShowMsg(const Text: String; Typ: TMsgBoxType; Buttons, Default: Integer): Integer;
begin
  Log('[msg] ' + Text);
  Result := SuppressibleMsgBox(Text, Typ, Buttons, Default);
end;

procedure ShowError(const Text: String);
begin
  ShowMsg(Text, mbError, MB_OK, IDOK);
end;

// Cada unidade UTF-16 vira 4 dígitos hexadecimais (o configure-env.js decodifica).
function HexEncode(const S: String): String;
var
  I, J, N: Integer;
  H: String;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    N := Ord(S[I]);
    H := '';
    for J := 1 to 4 do
    begin
      H := Copy('0123456789ABCDEF', (N mod 16) + 1, 1) + H;
      N := N div 16;
    end;
    Result := Result + H;
  end;
end;

function JoinLines(const Lines: TArrayOfString; First: Integer): String;
var I: Integer;
begin
  Result := '';
  for I := First to GetArrayLength(Lines) - 1 do
  begin
    if Result <> '' then Result := Result + #13#10;
    Result := Result + Lines[I];
  end;
end;

function IsValidPort(const S: String): Boolean;
var I, N: Integer;
begin
  Result := (Length(S) >= 1) and (Length(S) <= 5);
  if not Result then Exit;
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then
    begin
      Result := False;
      Exit;
    end;
  N := StrToIntDef(S, 0);
  Result := (N >= 1) and (N <= 65535);
end;

function SysExe(const Name: String): String;
begin
  Result := ExpandConstant('{sys}\') + Name;
end;

function PowerShellExe: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function RunHidden(const FileName, Params: String): Integer;
var Code: Integer;
begin
  if Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Result := Code
  else
    Result := -1;
  Log(Format('[exec] %s %s => %d', [FileName, Params, Result]));
end;

// ============================================================================
// .env existente (somente para PRÉ-PREENCHER os campos; quem lê/grava o .env
// de verdade é o configure-env.js, com o mesmo parser da aplicação)
// ============================================================================

procedure SetExisting(const Key, Value: String);
var I, N: Integer;
begin
  N := GetArrayLength(ExKeys);
  for I := 0 to N - 1 do
    if ExKeys[I] = Key then
    begin
      ExVals[I] := Value;
      Exit;
    end;
  SetArrayLength(ExKeys, N + 1);
  SetArrayLength(ExVals, N + 1);
  ExKeys[N] := Key;
  ExVals[N] := Value;
end;

function HasExisting(const Key: String): Boolean;
var I: Integer;
begin
  Result := False;
  for I := 0 to GetArrayLength(ExKeys) - 1 do
    if ExKeys[I] = Key then
    begin
      Result := True;
      Exit;
    end;
end;

function GetExisting(const Key: String): String;
var I: Integer;
begin
  Result := '';
  for I := 0 to GetArrayLength(ExKeys) - 1 do
    if ExKeys[I] = Key then
    begin
      Result := ExVals[I];
      Exit;
    end;
end;

procedure LoadExistingEnv(const FileName: String);
var
  Lines: TArrayOfString;
  I, P: Integer;
  L, K, V, Q: String;
begin
  SetArrayLength(ExKeys, 0);
  SetArrayLength(ExVals, 0);
  if not LoadStringsFromFile(FileName, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    L := Trim(Lines[I]);
    if (L = '') or (L[1] = '#') then Continue;
    if Copy(L, 1, 7) = 'export ' then L := Trim(Copy(L, 8, Length(L)));
    P := Pos('=', L);
    if P < 2 then Continue;
    K := Trim(Copy(L, 1, P - 1));
    V := Trim(Copy(L, P + 1, Length(L)));
    if (V <> '') and ((V[1] = '''') or (V[1] = '"') or (V[1] = '`')) then
    begin
      Q := V[1];
      V := Copy(V, 2, Length(V));
      P := Pos(Q, V);
      if P > 0 then V := Copy(V, 1, P - 1);
    end
    else
    begin
      P := Pos('#', V);
      if P > 0 then V := Trim(Copy(V, 1, P - 1));
    end;
    SetExisting(K, V);
  end;
end;

// ============================================================================
// Registro dos campos (cada campo = uma chave do .env)
// ============================================================================

function FieldIndex(const Key: String): Integer;
var I: Integer;
begin
  Result := -1;
  for I := 0 to GetArrayLength(FKeys) - 1 do
    if FKeys[I] = Key then
    begin
      Result := I;
      Exit;
    end;
end;

function Field(const Key: String): TNewEdit;
begin
  Result := FEdits[FieldIndex(Key)];
end;

function FieldText(const Key: String): String;
begin
  Result := Trim(Field(Key).Text);
end;

function LabelWidth(Page: TWizardPage): Integer;
begin
  Result := (Page.SurfaceWidth * 40) div 100;
end;

function AddNote(Page: TWizardPage; Top: Integer; const Caption: String; Left: Integer): TNewStaticText;
begin
  Result := TNewStaticText.Create(Page);
  Result.Parent := Page.Surface;
  Result.AutoSize := False;
  Result.WordWrap := True;
  Result.ShowAccelChar := False;
  Result.Left := Left;
  Result.Top := Top;
  Result.Width := Page.SurfaceWidth - Left;
  Result.Height := ScaleY(30);
  Result.Font.Color := clGrayText;
  Result.Caption := Caption;
end;

function AddField(Page: TWizardPage; var Top: Integer; const Key, Caption, Param, Default: String;
  Secret: Boolean; RightReserve: Integer): TNewEdit;
var
  L: TNewStaticText;
  E: TNewEdit;
  N, LW: Integer;
begin
  LW := LabelWidth(Page);
  E := TNewEdit.Create(Page);
  E.Parent := Page.Surface;
  E.Left := LW;
  E.Top := Top;
  E.Width := Page.SurfaceWidth - LW - RightReserve;
  if Secret then E.PasswordChar := '*';

  L := TNewStaticText.Create(Page);
  L.Parent := Page.Surface;
  L.AutoSize := False;
  L.WordWrap := False;
  L.Left := 0;
  L.Top := Top + ScaleY(3);
  L.Width := LW - ScaleX(8);
  L.Height := ScaleY(17);
  L.Caption := Caption;
  L.FocusControl := E;

  N := GetArrayLength(FKeys);
  SetArrayLength(FKeys, N + 1);
  SetArrayLength(FParams, N + 1);
  SetArrayLength(FDefaults, N + 1);
  SetArrayLength(FPrefill, N + 1);
  SetArrayLength(FEdits, N + 1);
  SetArrayLength(FSecret, N + 1);
  SetArrayLength(FFromParam, N + 1);
  FKeys[N] := Key;
  FParams[N] := Param;
  FDefaults[N] := Default;
  FPrefill[N] := '';
  FEdits[N] := E;
  FSecret[N] := Secret;
  FFromParam[N] := False;

  Top := Top + ScaleY(27);
  Result := E;
end;

function AddBrowseButton(Page: TWizardPage; Edit: TNewEdit; OnClick: TNotifyEvent): TNewButton;
begin
  Result := TNewButton.Create(Page);
  Result.Parent := Page.Surface;
  Result.Caption := 'Procurar...';
  Result.Width := ScaleX(80);
  Result.Height := Edit.Height + ScaleY(2);
  Result.Left := Page.SurfaceWidth - Result.Width;
  Result.Top := Edit.Top - ScaleY(1);
  Result.OnClick := OnClick;
end;

procedure BrowseClientPath(Sender: TObject);
var Dir: String;
begin
  Dir := FieldText('ORACLE_CLIENT_PATH');
  if BrowseForFolder('Selecione a pasta do Oracle Client 64-bit (a que contém oci.dll):', Dir, False) then
    Field('ORACLE_CLIENT_PATH').Text := Dir;
end;

procedure BrowseSshKey(Sender: TObject);
var F: String;
begin
  F := FieldText('SSH_PRIVATE_KEY_PATH');
  if GetOpenFileName('Selecione a chave privada SSH', F, '', 'Todos os arquivos (*.*)|*.*', '') then
    Field('SSH_PRIVATE_KEY_PATH').Text := F;
end;

procedure UpdateDemoState;
var Enabled: Boolean;
begin
  Enabled := not CbDemo.Checked;
  Field('DB_HOST').Enabled := Enabled;
  Field('DB_PORT').Enabled := Enabled;
  Field('DB_SERVICE').Enabled := Enabled;
  Field('DB_USER').Enabled := Enabled;
  Field('DB_PASSWORD').Enabled := Enabled;
end;

procedure DemoClick(Sender: TObject);
begin
  UpdateDemoState;
end;

// ============================================================================
// Pré-preenchimento: parâmetro de linha de comando > .env existente > padrão
// ============================================================================

function IsKeep: Boolean;
begin
  Result := ExistingEnv and RbKeep.Checked;
end;

procedure SetPassHint(Lb: TNewStaticText; const Key: String);
begin
  Lb.Visible := ExistingEnv and HasExisting(Key) and (GetExisting(Key) <> '');
end;

procedure ApplyPrefill;
var
  I: Integer;
  V: String;
begin
  for I := 0 to GetArrayLength(FKeys) - 1 do
  begin
    FFromParam[I] := HasParam(FParams[I]);
    if FFromParam[I] then
      V := ParamValue(FParams[I])
    else if FSecret[I] then
      V := ''
    else if ExistingEnv and HasExisting(FKeys[I]) then
      V := GetExisting(FKeys[I])
    else
      V := FDefaults[I];
    FEdits[I].Text := V;
    FPrefill[I] := V;
  end;
  EdAuthPass2.Text := Field('AUTH_PASS').Text;

  DemoFromParam := HasParam('DEMO');
  if DemoFromParam then
    DemoPrefill := IsTrueText(ParamValue('DEMO'))
  else if ExistingEnv then
    DemoPrefill := IsTrueText(GetExisting('DEMO_MODE'))
  else
    DemoPrefill := False;
  CbDemo.Checked := DemoPrefill;
  UpdateDemoState;

  if HasParam('KEEPCONFIG') then
    RbKeep.Checked := IsTrueText(ParamValue('KEEPCONFIG'))
  else
    RbKeep.Checked := True;
  RbEdit.Checked := not RbKeep.Checked;

  // "Deixe em branco para manter" só faz sentido quando já existe a senha.
  SetPassHint(LbDbPassHint, 'DB_PASSWORD');
  SetPassHint(LbAuthPassHint, 'AUTH_PASS_HASH');
  SetPassHint(LbSshPassHint, 'SSH_PASSWORD');
  SetPassHint(LbSysPassHint, 'DB_SYS_PASSWORD');
end;

procedure EnsureExistingLoaded;
var Dir, EnvFile: String;
begin
  Dir := WizardDirValue;
  if EnvLoaded and (CompareText(Dir, LoadedForDir) = 0) then Exit;
  EnvLoaded := True;
  LoadedForDir := Dir;
  DryRunPassed := False;
  EnvFile := AddBackslash(Dir) + '.env';
  ExistingEnv := FileExists(EnvFile);
  if ExistingEnv then
    LoadExistingEnv(EnvFile)
  else
  begin
    SetArrayLength(ExKeys, 0);
    SetArrayLength(ExVals, 0);
  end;
  KeepInfo.Caption := 'Foi encontrada uma configuração do Oracle Pulse em:' + #13#10 + EnvFile + #13#10#13#10 +
    'Ao manter, o arquivo não é alterado (senhas e demais ajustes continuam iguais). ' +
    'Ao revisar, os campos vêm preenchidos com os valores atuais; senhas deixadas em branco são mantidas, ' +
    'e é feita uma cópia de segurança (.env.bak-data) antes de gravar.';
  Log('Pasta: ' + Dir + ' | .env existente: ' + IntToStr(Ord(ExistingEnv)));
  ApplyPrefill;
end;

function GetPanelPort(Param: String): String;
begin
  if PanelPort <> '' then
    Result := PanelPort
  else if IsKeep then
  begin
    Result := Trim(GetExisting('PORT'));
    if not IsValidPort(Result) then Result := '3000';
  end
  else
    Result := FieldText('PORT');
end;

function PanelIsUp: Boolean;
begin
  Result := HttpOk;
end;

// ============================================================================
// Ferramenta configure-env.js (validação antes de instalar e gravação depois)
// ============================================================================

function TmpAppDir: String;
begin
  // ExtractTemporaryFiles mantém o destino sem expandir: {tmp}\{app}\...
  Result := ExpandConstant('{tmp}') + '\{app}';
end;

function ExtractTools: Boolean;
begin
  if not ToolsExtracted then
  begin
    try
      ExtractTemporaryFiles('{app}\runtime\node.exe');
      ExtractTemporaryFiles('{app}\tools\configure-env.js');
      ExtractTemporaryFiles('{app}\node_modules\dotenv\package.json');
      ExtractTemporaryFiles('{app}\node_modules\dotenv\lib\main.js');
      ToolsExtracted := True;
    except
      Log('Falha ao extrair as ferramentas de validação: ' + GetExceptionMessage);
    end;
  end;
  Result := ToolsExtracted;
end;

// Executa "node configure-env.js <Args> --result <arquivo>" e devolve as linhas do resultado.
function RunTool(const NodeExe, ToolJs, Args: String; var Lines: TArrayOfString): Integer;
var ResFile: String;
begin
  ResFile := ExpandConstant('{tmp}\op-result.txt');
  DeleteFile(ResFile);
  SetArrayLength(Lines, 0);
  Result := RunHidden(NodeExe, '"' + ToolJs + '" ' + Args + ' --result "' + ResFile + '"');
  if not LoadStringsFromFile(ResFile, Lines) or (GetArrayLength(Lines) = 0) then
  begin
    SetArrayLength(Lines, 2);
    Lines[0] := 'ERRO';
    Lines[1] := 'A ferramenta de configuração não respondeu (código ' + IntToStr(Result) + ').';
    if Result = 0 then Result := -2;
  end;
  DeleteFile(ResFile);
end;

function SendField(I: Integer): Boolean;
var T: String;
begin
  T := FEdits[I].Text;
  if not FSecret[I] then T := Trim(T);
  if FSecret[I] then
    // Senha em branco = manter a atual (ou ausente, numa instalação nova).
    Result := (T <> '') or (not ExistingEnv)
  else
    Result := (not ExistingEnv) or FFromParam[I] or (T <> FPrefill[I]);
end;

procedure WriteInputFile(const FileName: String);
var
  Lines: TArrayOfString;
  I, N: Integer;
  T: String;
begin
  SetArrayLength(Lines, 0);
  for I := 0 to GetArrayLength(FKeys) - 1 do
    if SendField(I) then
    begin
      T := FEdits[I].Text;
      if not FSecret[I] then T := Trim(T);
      N := GetArrayLength(Lines);
      SetArrayLength(Lines, N + 1);
      Lines[N] := FKeys[I] + '=' + HexEncode(T);
    end;
  if (not ExistingEnv) or DemoFromParam or (CbDemo.Checked <> DemoPrefill) then
  begin
    N := GetArrayLength(Lines);
    SetArrayLength(Lines, N + 1);
    if CbDemo.Checked then
      Lines[N] := 'DEMO_MODE=' + HexEncode('true')
    else
      Lines[N] := 'DEMO_MODE=' + HexEncode('false');
  end;
  SaveStringsToFile(FileName, Lines, False);
end;

// Valida a configuração digitada com o mesmo código que vai gravar o .env.
function RunDryRun(var Msg: String): Boolean;
var
  Lines: TArrayOfString;
  InFile: String;
  Code: Integer;
begin
  Result := False;
  if not ExtractTools then
  begin
    Msg := 'Não foi possível preparar a validação da configuração (falha ao extrair arquivos temporários).';
    Exit;
  end;
  InFile := ExpandConstant('{tmp}\op-input.txt');
  WriteInputFile(InFile);
  Code := RunTool(TmpAppDir + '\runtime\node.exe', TmpAppDir + '\tools\configure-env.js',
    'write --dry-run --env "' + AddBackslash(WizardDirValue) + '.env" --input "' + InFile + '"', Lines);
  DeleteFile(InFile);
  Result := (Code = 0) and (GetArrayLength(Lines) > 0) and (Lines[0] = 'OK');
  if not Result then
    Msg := 'Corrija a configuração:' + #13#10#13#10 + JoinLines(Lines, 1);
  DryRunPassed := Result;
end;

// ============================================================================
// Serviço do Windows, processos e firewall
// ============================================================================

function ServiceExists: Boolean;
begin
  Result := RunHidden(SysExe('sc.exe'), 'query ' + SERVICE_NAME) = 0;
end;

function ServiceImagePath: String;
var S: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Services\' + SERVICE_NAME, 'ImagePath', S) then
  begin
    S := Trim(S);
    if (S <> '') and (S[1] = '"') then
    begin
      S := Copy(S, 2, Length(S));
      if Pos('"', S) > 0 then S := Copy(S, 1, Pos('"', S) - 1);
    end;
    Result := S;
  end;
end;

function WrapperExe(const AppDir: String): String;
begin
  Result := AddBackslash(AppDir) + 'service\OraclePulse.exe';
end;

// Aguarda o WinSW e o node.exe DESTA instalação saírem (até 15 s) e encerra o
// que tiver sobrado — nunca outros processos Node.js da máquina.
procedure KillAppNode(const AppDir: String);
var Script: String;
begin
  Script := ExpandConstant('{tmp}\op-kill-node.ps1');
  SaveStringToFile(Script,
    'param([string]$NodePath, [string]$WrapperPath)' + #13#10 +
    'function Mine { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (($_.Path -ieq $NodePath) -or ($_.Path -ieq $WrapperPath)) } }' + #13#10 +
    'for ($i = 0; $i -lt 30 -and (Mine); $i++) { Start-Sleep -Milliseconds 500 }' + #13#10 +
    'Mine | Stop-Process -Force -ErrorAction SilentlyContinue' + #13#10 +
    'Start-Sleep -Milliseconds 500' + #13#10 + 'exit 0' + #13#10, False);
  RunHidden(PowerShellExe, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script +
    '" -NodePath "' + AddBackslash(AppDir) + 'runtime\node.exe" -WrapperPath "' + WrapperExe(AppDir) + '"');
end;

procedure StopService(const AppDir: String);
var Wrapper: String;
begin
  if not ServiceExists then Exit;
  Wrapper := ServiceImagePath;
  if (Wrapper = '') or not FileExists(Wrapper) then Wrapper := WrapperExe(AppDir);
  if FileExists(Wrapper) then
    RunHidden(Wrapper, 'stopwait')
  else
    RunHidden(SysExe('net.exe'), 'stop ' + SERVICE_NAME);
  KillAppNode(AppDir);
end;

function WaitServiceGone(Seconds: Integer): Boolean;
var I: Integer;
begin
  for I := 1 to Seconds do
  begin
    if not ServiceExists then
    begin
      Result := True;
      Exit;
    end;
    Sleep(1000);
  end;
  Result := not ServiceExists;
end;

procedure RemoveService(const AppDir: String);
var Wrapper: String;
begin
  if not ServiceExists then Exit;
  Wrapper := ServiceImagePath;
  if (Wrapper <> '') and FileExists(Wrapper) then
    RunHidden(Wrapper, 'uninstall')
  else
    RunHidden(SysExe('sc.exe'), 'delete ' + SERVICE_NAME);
  if not WaitServiceGone(20) then
    RunHidden(SysExe('sc.exe'), 'delete ' + SERVICE_NAME);
end;

function EnsureServiceInstalled(const AppDir: String): Boolean;
var
  Wrapper: String;
  I: Integer;
begin
  Wrapper := WrapperExe(AppDir);
  // Serviço registrado apontando para OUTRA pasta: refaz o registro.
  if ServiceExists and (CompareText(ServiceImagePath, Wrapper) <> 0) then
  begin
    Log('Serviço existente aponta para "' + ServiceImagePath + '"; registrando novamente.');
    RemoveService(AppDir);
    WaitServiceGone(30);
  end;
  if not ServiceExists then
    for I := 1 to 10 do
    begin
      if RunHidden(Wrapper, 'install') = 0 then Break;
      Sleep(3000);  // ex.: serviço anterior ainda "marcado para exclusão"
    end;
  Result := ServiceExists;
  if Result then
  begin
    // Mantém o registro do serviço igual ao do XML mesmo em atualizações.
    RunHidden(SysExe('sc.exe'), 'config ' + SERVICE_NAME + ' start= delayed-auto');
    RunHidden(SysExe('sc.exe'), 'failure ' + SERVICE_NAME + ' reset= 3600 actions= restart/10000/restart/30000/restart/60000');
  end;
end;

procedure ConfigureFirewall(const Port: String; Enable: Boolean);
begin
  RunHidden(SysExe('netsh.exe'), 'advfirewall firewall delete rule name="' + FIREWALL_RULE + '"');
  if Enable then
    RunHidden(SysExe('netsh.exe'), 'advfirewall firewall add rule name="' + FIREWALL_RULE +
      '" dir=in action=allow protocol=TCP localport=' + Port + ' profile=any description="Painel web Oracle Pulse"');
end;

// 0 = porta livre; 1 = em uso por outro programa; 2 = em uso por esta instalação.
function PortStatus(const Port, AppDir: String): Integer;
var Script: String;
begin
  Script := ExpandConstant('{tmp}\op-port.ps1');
  SaveStringToFile(Script,
    'param([int]$Port, [string]$NodePath)' + #13#10 +
    '$c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1' + #13#10 +
    'if (-not $c) { exit 0 }' + #13#10 +
    '$p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue' + #13#10 +
    'if ($p -and $p.Path -and ($p.Path -ieq $NodePath)) { exit 2 }' + #13#10 +
    'exit 1' + #13#10, False);
  Result := RunHidden(PowerShellExe, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script +
    '" -Port ' + Port + ' -NodePath "' + AddBackslash(AppDir) + 'runtime\node.exe"');
end;

function HttpStatusOnce(const Url: String): Integer;
var Req: Variant;
begin
  Result := 0;
  try
    Req := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Req.SetProxy(1);  // HTTPREQUEST_PROXYSETTING_DIRECT: nunca via proxy
    Req.SetTimeouts(3000, 3000, 3000, 3000);
    Req.Open('GET', Url, False);
    Req.Send('');
    Result := Req.Status;
  except
    Result := 0;
  end;
end;

function WaitHttp(const Url: String; Seconds: Integer): Boolean;
var I: Integer;
begin
  for I := 1 to Seconds do
  begin
    if HttpStatusOnce(Url) = 200 then
    begin
      Result := True;
      Exit;
    end;
    Sleep(1000);
  end;
  Result := False;
end;

procedure SecureEnvFiles(const AppDir: String);
var
  Grant: String;
  FR: TFindRec;
begin
  // Só Administradores (S-1-5-32-544) e SYSTEM (S-1-5-18): o .env tem senhas.
  Grant := ' /inheritance:r /grant:r *S-1-5-32-544:(F) *S-1-5-18:(F)';
  if FileExists(AddBackslash(AppDir) + '.env') then
    RunHidden(SysExe('icacls.exe'), '"' + AddBackslash(AppDir) + '.env"' + Grant);
  if FindFirst(AddBackslash(AppDir) + '.env.bak-*', FR) then
  begin
    FindClose(FR);
    RunHidden(SysExe('icacls.exe'), '"' + AddBackslash(AppDir) + '.env.bak-*"' + Grant);
  end;
end;

// ============================================================================
// Páginas do assistente
// ============================================================================

procedure CreatePages;
var
  Top: Integer;
  E: TNewEdit;
  L: TNewStaticText;
begin
  // ---- Senha de instalação (primeira página, logo após as boas-vindas) ----
#if defined(IK_HAS_GATE) && !defined(PREVIEW)
  PagePwd := CreateInputQueryPage(wpWelcome,
    'Senha de instalação',
    'Informe a senha do dia para instalar o Oracle Pulse',
    'Use a senha de HOJE gerada pelo aplicativo "Oracle Pulse".');
  PagePwd.Add('Senha de instalação:', True);   // True = campo mascarado
  if HasParam('INSTALLPWD') then
    PagePwd.Values[0] := ParamValue('INSTALLPWD');
#endif

  // ---- Configuração existente ----
  PageKeep := CreateCustomPage(wpSelectDir, 'Configuração existente',
    'Escolha se a configuração atual (.env) será mantida ou revisada.');
  KeepInfo := TNewStaticText.Create(PageKeep);
  KeepInfo.Parent := PageKeep.Surface;
  KeepInfo.AutoSize := False;
  KeepInfo.WordWrap := True;
  KeepInfo.ShowAccelChar := False;
  KeepInfo.Left := 0;
  KeepInfo.Top := 0;
  KeepInfo.Width := PageKeep.SurfaceWidth;
  KeepInfo.Height := ScaleY(110);
  RbKeep := TNewRadioButton.Create(PageKeep);
  RbKeep.Parent := PageKeep.Surface;
  RbKeep.Left := 0;
  RbKeep.Top := ScaleY(120);
  RbKeep.Width := PageKeep.SurfaceWidth;
  RbKeep.Height := ScaleY(20);
  RbKeep.Caption := 'Manter a configuração atual (recomendado para atualizar a versão)';
  RbKeep.Checked := True;
  RbEdit := TNewRadioButton.Create(PageKeep);
  RbEdit.Parent := PageKeep.Surface;
  RbEdit.Left := 0;
  RbEdit.Top := ScaleY(146);
  RbEdit.Width := PageKeep.SurfaceWidth;
  RbEdit.Height := ScaleY(20);
  RbEdit.Caption := 'Revisar e alterar a configuração';

  // ---- Banco de dados Oracle (obrigatório) ----
  PageDb := CreateCustomPage(PageKeep.ID, 'Banco de dados Oracle',
    'Dados de conexão do painel com o banco (obrigatórios).');
  CbDemo := TNewCheckBox.Create(PageDb);
  CbDemo.Parent := PageDb.Surface;
  CbDemo.Left := 0;
  CbDemo.Top := 0;
  CbDemo.Width := PageDb.SurfaceWidth;
  CbDemo.Height := ScaleY(20);
  CbDemo.Caption := 'Modo DEMONSTRAÇÃO (dados simulados, sem conectar a um banco)';
  CbDemo.OnClick := @DemoClick;
  Top := ScaleY(30);
  AddField(PageDb, Top, 'DB_HOST', 'Host ou IP do servidor:', 'DBHOST', '', False, 0);
  AddField(PageDb, Top, 'DB_PORT', 'Porta do listener:', 'DBPORT', '1521', False, 0);
  AddField(PageDb, Top, 'DB_SERVICE', 'Service name:', 'DBSERVICE', '', False, 0);
  AddField(PageDb, Top, 'DB_USER', 'Usuário do banco:', 'DBUSER', '', False, 0);
  E := AddField(PageDb, Top, 'DB_PASSWORD', 'Senha do banco:', 'DBPASSWORD', '', True, 0);
  LbDbPassHint := AddNote(PageDb, Top - ScaleY(4), 'Deixe a senha em branco para manter a atual.', LabelWidth(PageDb));
  LbDbPassHint.Height := ScaleY(16);
  L := AddNote(PageDb, Top + ScaleY(16),
    'O usuário precisa ler as views V$ e DBA_ (ex.: GRANT SELECT_CATALOG_ROLE). Use o usuário SYS ' +
    'apenas se necessário (conecta como SYSDBA). A conexão é testada ao final da instalação.', 0);
  L.Height := ScaleY(46);

  // ---- Acesso ao painel (obrigatório) ----
  PageAuth := CreateCustomPage(PageDb.ID, 'Acesso ao painel',
    'Porta do painel web e credenciais de login (obrigatórios).');
  Top := 0;
  AddField(PageAuth, Top, 'PORT', 'Porta HTTP do painel:', 'PORT', '3000', False, 0);
  AddField(PageAuth, Top, 'AUTH_USER', 'Usuário administrador (DBA):', 'AUTHUSER', 'DBA', False, 0);
  AddField(PageAuth, Top, 'AUTH_PASS', 'Senha:', 'AUTHPASSWORD', '', True, 0);
  EdAuthPass2 := TNewEdit.Create(PageAuth);
  EdAuthPass2.Parent := PageAuth.Surface;
  EdAuthPass2.Left := LabelWidth(PageAuth);
  EdAuthPass2.Top := Top;
  EdAuthPass2.Width := PageAuth.SurfaceWidth - LabelWidth(PageAuth);
  EdAuthPass2.PasswordChar := '*';
  L := TNewStaticText.Create(PageAuth);
  L.Parent := PageAuth.Surface;
  L.AutoSize := False;
  L.Left := 0;
  L.Top := Top + ScaleY(3);
  L.Width := LabelWidth(PageAuth) - ScaleX(8);
  L.Height := ScaleY(17);
  L.Caption := 'Confirme a senha:';
  L.FocusControl := EdAuthPass2;
  Top := Top + ScaleY(27);
  LbAuthPassHint := AddNote(PageAuth, Top - ScaleY(4), 'Deixe em branco para manter a senha atual.', LabelWidth(PageAuth));
  LbAuthPassHint.Height := ScaleY(16);
  Top := Top + ScaleY(18);
  L := AddNote(PageAuth, Top, 'Conta somente leitura (opcional):', 0);
  L.Height := ScaleY(18);
  Top := Top + ScaleY(22);
  AddField(PageAuth, Top, 'AUTH_VIEWER_USER', 'Usuário (somente leitura):', 'VIEWERUSER', '', False, 0);
  AddField(PageAuth, Top, 'AUTH_VIEWER_PASS', 'Senha (somente leitura):', 'VIEWERPASSWORD', '', True, 0);
  L := AddNote(PageAuth, Top, 'A senha é gravada no .env apenas como hash (scrypt), mínimo de ' + IntToStr(MIN_PASSWORD) +
    ' caracteres. O perfil DBA executa ações administrativas; o somente leitura apenas consulta.', 0);
  L.Height := ScaleY(46);

  // ---- SSH (opcional) ----
  PageSsh := CreateCustomPage(PageAuth.ID, 'Acesso SSH ao servidor do banco (opcional)',
    'Usado para ler disco/memória e executar RMAN quando o banco roda em OUTRA máquina.');
  Top := 0;
  L := AddNote(PageSsh, Top, 'Deixe tudo em branco se o banco Oracle roda NESTE servidor. ' +
    'Informe a senha ou o caminho de uma chave privada.', 0);
  L.Height := ScaleY(32);
  Top := ScaleY(38);
  AddField(PageSsh, Top, 'SSH_HOST', 'Host ou IP (SSH):', 'SSHHOST', '', False, 0);
  AddField(PageSsh, Top, 'SSH_PORT', 'Porta SSH:', 'SSHPORT', '22', False, 0);
  AddField(PageSsh, Top, 'SSH_USER', 'Usuário SSH:', 'SSHUSER', '', False, 0);
  AddField(PageSsh, Top, 'SSH_PASSWORD', 'Senha SSH:', 'SSHPASSWORD', '', True, 0);
  LbSshPassHint := AddNote(PageSsh, Top - ScaleY(4), 'Deixe em branco para manter a senha atual.', LabelWidth(PageSsh));
  LbSshPassHint.Height := ScaleY(16);
  Top := Top + ScaleY(14);
  E := AddField(PageSsh, Top, 'SSH_PRIVATE_KEY_PATH', 'Chave privada (opcional):', 'SSHKEY', '', False, ScaleX(88));
  AddBrowseButton(PageSsh, E, @BrowseSshKey);

  // ---- Avançado: Oracle Client e RMAN (opcional) ----
  PageAdv := CreateCustomPage(PageSsh.ID, 'Oracle Client e automação RMAN (opcional)',
    'Preencha só o que for usar. Sem isso, o painel apenas exibe os comandos RMAN.');
  Top := 0;
  E := AddField(PageAdv, Top, 'ORACLE_CLIENT_PATH', 'Oracle Client (modo THICK):', 'ORACLECLIENT', '', False, ScaleX(88));
  AddBrowseButton(PageAdv, E, @BrowseClientPath);
  L := AddNote(PageAdv, Top - ScaleY(4), 'Vazio = modo THIN, sem Oracle Client (recomendado).', LabelWidth(PageAdv));
  L.Height := ScaleY(16);
  Top := Top + ScaleY(16);
  AddField(PageAdv, Top, 'DB_ORACLE_HOME', 'ORACLE_HOME no servidor:', 'ORACLEHOME', '', False, 0);
  AddField(PageAdv, Top, 'DB_ORACLE_SID', 'ORACLE_SID:', 'ORACLESID', '', False, 0);
  AddField(PageAdv, Top, 'DB_OS_USER', 'Usuário do SO dono do Oracle:', 'OSUSER', '', False, 0);
  AddField(PageAdv, Top, 'DB_SYS_USER', 'Usuário administrativo:', 'SYSUSER', 'sys', False, 0);
  AddField(PageAdv, Top, 'DB_SYS_PASSWORD', 'Senha do SYS:', 'SYSPASSWORD', '', True, 0);
  LbSysPassHint := AddNote(PageAdv, Top - ScaleY(4), 'Deixe em branco para manter a senha atual.', LabelWidth(PageAdv));
  LbSysPassHint.Height := ScaleY(16);
  Top := Top + ScaleY(14);
  AddField(PageAdv, Top, 'DB_TNS_ALIAS', 'Alias TNS (Windows):', 'TNSALIAS', '', False, 0);
  AddField(PageAdv, Top, 'DB_FRA_DEST', 'Destino da FRA (opcional):', 'FRADEST', '', False, 0);
end;

procedure InitializeWizard;
begin
  CreatePages;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (PageID = PageKeep.ID) or (PageID = PageDb.ID) or (PageID = PageAuth.ID) or
     (PageID = PageSsh.ID) or (PageID = PageAdv.ID) then
  begin
    EnsureExistingLoaded;
    if PageID = PageKeep.ID then
      Result := not ExistingEnv
    else
      Result := IsKeep;
  end;
end;

// ---------------------------------------------------------------------------
// Validação por página (feedback imediato); a validação final é o dry-run.
// ---------------------------------------------------------------------------

function DirHasEntries(const Dir: String): Boolean;
var FR: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(Dir) + '*', FR) then
  try
    repeat
      if (FR.Name <> '.') and (FR.Name <> '..') then
      begin
        Result := True;
        Break;
      end;
    until not FindNext(FR);
  finally
    FindClose(FR);
  end;
end;

function ValidateDir: Boolean;
var Dir: String;
begin
  Result := False;
  Dir := RemoveBackslashUnlessRoot(WizardDirValue);
  if Length(Dir) <= 3 then
  begin
    ShowError('Escolha uma pasta (ex.: C:\OraclePulse), não a raiz de um disco.');
    Exit;
  end;
  if DirExists(Dir) and DirHasEntries(Dir) and not FileExists(AddBackslash(Dir) + 'server.js') and
     not FileExists(AddBackslash(Dir) + '.env') then
  begin
    ShowError('A pasta escolhida já contém outros arquivos.' + #13#10 +
      'Escolha uma pasta vazia ou uma instalação existente do Oracle Pulse.');
    Exit;
  end;
  Result := True;
end;

function Require(const Value, Name: String; var Msg: String): Boolean;
begin
  Result := Value <> '';
  if not Result then Msg := Msg + '- ' + Name + #13#10;
end;

function NeedsSecret(const Edit: TNewEdit; const ExistingKey: String): Boolean;
begin
  Result := (Edit.Text = '') and not (ExistingEnv and (GetExisting(ExistingKey) <> ''));
end;

function ValidateDbPage: Boolean;
var Msg: String;
begin
  Msg := '';
  if not CbDemo.Checked then
  begin
    Require(FieldText('DB_HOST'), 'Host ou IP do servidor', Msg);
    if not IsValidPort(FieldText('DB_PORT')) then Msg := Msg + '- Porta do listener (número entre 1 e 65535)' + #13#10;
    Require(FieldText('DB_SERVICE'), 'Service name', Msg);
    Require(FieldText('DB_USER'), 'Usuário do banco', Msg);
    if NeedsSecret(Field('DB_PASSWORD'), 'DB_PASSWORD') then Msg := Msg + '- Senha do banco' + #13#10;
  end;
  Result := Msg = '';
  if not Result then ShowError('Preencha corretamente:' + #13#10#13#10 + Msg);
end;

function ValidateAuthPage: Boolean;
var
  Msg, P1, Port: String;
  St: Integer;
begin
  Result := False;
  Msg := '';
  Port := FieldText('PORT');
  if not IsValidPort(Port) then Msg := Msg + '- Porta HTTP do painel (número entre 1 e 65535)' + #13#10;
  Require(FieldText('AUTH_USER'), 'Usuário administrador', Msg);
  P1 := Field('AUTH_PASS').Text;
  if NeedsSecret(Field('AUTH_PASS'), 'AUTH_PASS_HASH') then
    Msg := Msg + '- Senha do administrador' + #13#10
  else if P1 <> '' then
  begin
    if Length(P1) < MIN_PASSWORD then
      Msg := Msg + '- A senha do administrador deve ter ao menos ' + IntToStr(MIN_PASSWORD) + ' caracteres' + #13#10
    else if P1 <> EdAuthPass2.Text then
      Msg := Msg + '- A confirmação não confere com a senha do administrador' + #13#10;
  end;
  if FieldText('AUTH_VIEWER_USER') <> '' then
  begin
    if NeedsSecret(Field('AUTH_VIEWER_PASS'), 'AUTH_VIEWER_PASS_HASH') then
      Msg := Msg + '- Senha da conta somente leitura' + #13#10
    else if (Field('AUTH_VIEWER_PASS').Text <> '') and (Length(Field('AUTH_VIEWER_PASS').Text) < MIN_PASSWORD) then
      Msg := Msg + '- A senha somente leitura deve ter ao menos ' + IntToStr(MIN_PASSWORD) + ' caracteres' + #13#10;
    if CompareText(FieldText('AUTH_VIEWER_USER'), FieldText('AUTH_USER')) = 0 then
      Msg := Msg + '- O usuário somente leitura deve ser diferente do administrador' + #13#10;
  end
  else if Field('AUTH_VIEWER_PASS').Text <> '' then
    Msg := Msg + '- Informe o usuário da conta somente leitura (ou apague a senha dela)' + #13#10;
  if Msg <> '' then
  begin
    ShowError('Preencha corretamente:' + #13#10#13#10 + Msg);
    Exit;
  end;

  St := PortStatus(Port, WizardDirValue);
  if St = 1 then
    if ShowMsg('A porta ' + Port + ' já está em uso por outro programa neste servidor.' + #13#10 +
      'O painel não conseguirá iniciar enquanto ela estiver ocupada.' + #13#10#13#10 +
      'Deseja continuar mesmo assim?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) <> IDYES then
      Exit;
  Result := True;
end;

function ValidateSshPage: Boolean;
var Msg, Key: String;
begin
  Result := False;
  Msg := '';
  if FieldText('SSH_HOST') <> '' then
  begin
    if not IsValidPort(FieldText('SSH_PORT')) then Msg := Msg + '- Porta SSH (número entre 1 e 65535)' + #13#10;
    Require(FieldText('SSH_USER'), 'Usuário SSH', Msg);
    if (FieldText('SSH_PRIVATE_KEY_PATH') = '') and NeedsSecret(Field('SSH_PASSWORD'), 'SSH_PASSWORD') then
      Msg := Msg + '- Senha SSH ou chave privada' + #13#10;
  end;
  if Msg <> '' then
  begin
    ShowError('Preencha corretamente:' + #13#10#13#10 + Msg);
    Exit;
  end;
  Key := FieldText('SSH_PRIVATE_KEY_PATH');
  if (Key <> '') and not FileExists(Key) then
    if ShowMsg('O arquivo da chave privada não foi encontrado:' + #13#10 + Key + #13#10#13#10 +
      'Continuar mesmo assim?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) <> IDYES then
      Exit;
  Result := True;
end;

function ValidateAdvPage: Boolean;
var Msg, Dir: String;
begin
  Result := False;
  Dir := FieldText('ORACLE_CLIENT_PATH');
  if (Dir <> '') and not FileExists(AddBackslash(Dir) + 'oci.dll') then
    if ShowMsg('Não encontrei o oci.dll em:' + #13#10 + Dir + #13#10#13#10 +
      'Sem o Oracle Client nessa pasta o painel usará o modo THIN (funciona normalmente). Continuar?',
      mbConfirmation, MB_YESNO, IDYES) <> IDYES then
      Exit;
  if not RunDryRun(Msg) then
  begin
    ShowError(Msg);
    Exit;
  end;
  Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
#if defined(IK_HAS_GATE) && !defined(PREVIEW)
  if CurPageID = PagePwd.ID then
  begin
    Result := IKAccepts(PagePwd.Values[0]);
    if not Result then
      ShowError('Senha de instalação incorreta.' + #13#10 +
        'Use a senha de HOJE gerada pelo aplicativo "Oracle Pulse".');
    Exit;
  end;
#endif
  if CurPageID = wpSelectDir then
  begin
    Result := ValidateDir;
    if Result then EnsureExistingLoaded;
  end
  else if CurPageID = PageDb.ID then
    Result := ValidateDbPage
  else if CurPageID = PageAuth.ID then
    Result := ValidateAuthPage
  else if CurPageID = PageSsh.ID then
    Result := ValidateSshPage
  else if CurPageID = PageAdv.ID then
    Result := ValidateAdvPage;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var S: String;
begin
  S := MemoDirInfo + NewLine + NewLine;
  if IsKeep then
    S := S + 'Configuração:' + NewLine + Space + 'manter o .env existente (sem alterações)' + NewLine
  else
  begin
    S := S + 'Painel web:' + NewLine + Space + 'http://localhost:' + FieldText('PORT') +
      '   (login: ' + FieldText('AUTH_USER') + ')' + NewLine;
    if FieldText('AUTH_VIEWER_USER') <> '' then
      S := S + Space + 'conta somente leitura: ' + FieldText('AUTH_VIEWER_USER') + NewLine;
    S := S + 'Banco Oracle:' + NewLine;
    if CbDemo.Checked then
      S := S + Space + 'modo DEMONSTRAÇÃO (sem banco)' + NewLine
    else
      S := S + Space + FieldText('DB_HOST') + ':' + FieldText('DB_PORT') + '/' + FieldText('DB_SERVICE') +
        '  (usuário ' + FieldText('DB_USER') + ')' + NewLine;
    if FieldText('ORACLE_CLIENT_PATH') <> '' then
      S := S + Space + 'Oracle Client (THICK): ' + FieldText('ORACLE_CLIENT_PATH') + NewLine
    else
      S := S + Space + 'modo THIN (sem Oracle Client)' + NewLine;
    S := S + 'SSH:' + NewLine;
    if FieldText('SSH_HOST') <> '' then
      S := S + Space + FieldText('SSH_USER') + '@' + FieldText('SSH_HOST') + ':' + FieldText('SSH_PORT') + NewLine
    else
      S := S + Space + 'não usado (banco nesta máquina)' + NewLine;
    S := S + 'Automação RMAN:' + NewLine;
    if (FieldText('DB_ORACLE_HOME') <> '') and ((FieldText('DB_ORACLE_SID') <> '') or (FieldText('DB_SERVICE') <> '')) then
      S := S + Space + 'ativa (ORACLE_HOME ' + FieldText('DB_ORACLE_HOME') + ')' + NewLine
    else
      S := S + Space + 'desativada (o painel exibe os comandos para execução manual)' + NewLine;
  end;
  S := S + NewLine + 'Serviço do Windows:' + NewLine + Space + SERVICE_NAME + ' (início automático, reinicia em caso de falha)' + NewLine;
  if MemoTasksInfo <> '' then S := S + NewLine + MemoTasksInfo + NewLine;
  Result := S;
end;

// ============================================================================
// Instalação
// ============================================================================

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Msg: String;
begin
  Result := '';
#ifdef PREVIEW
  Result := 'Build de pré-visualização: nada foi instalado.';
  Exit;
#endif
  // Gate da senha de instalação (vale para a instalação SILENCIOSA e reforça a
  // interativa). Na silenciosa, a senha vem por /INSTALLPWD="senha-do-dia".
  // Só existe quando o arquivo privado install-key.iss está presente na compilação.
#ifdef IK_HAS_GATE
  if not IKAccepts(ParamValue('INSTALLPWD')) and not IKAccepts(PagePwd.Values[0]) then
  begin
    Result := 'Senha de instalação ausente ou incorreta.' + #13#10 +
      'Instalação silenciosa: use /INSTALLPWD="senha-do-dia" (aplicativo gerador "Oracle Pulse").';
    Exit;
  end;
#endif
  EnsureExistingLoaded;
  if not IsKeep and not DryRunPassed then
    if not RunDryRun(Msg) then
    begin
      Result := Msg;
      Exit;
    end;
  // Atualização: para o serviço antes de substituir os arquivos.
  StopService(WizardDirValue);
end;

procedure SetStatus(const Text: String);
begin
  WizardForm.StatusLabel.Caption := Text;
  Log('[etapa] ' + Text);
end;

procedure ReadInfo(const Lines: TArrayOfString);
var I: Integer;
begin
  for I := 1 to GetArrayLength(Lines) - 1 do
  begin
    if Copy(Lines[I], 1, 5) = 'PORT=' then PanelPort := Copy(Lines[I], 6, Length(Lines[I]));
    if Copy(Lines[I], 1, 10) = 'DEMO_MODE=' then DemoMode := Copy(Lines[I], 11, Length(Lines[I])) = 'true';
    if Copy(Lines[I], 1, 6) = 'AVISO=' then
      FinishWarnings := FinishWarnings + '- ' + Copy(Lines[I], 7, Length(Lines[I])) + #13#10;
  end;
end;

procedure WriteStatusFile(const AppDir: String);
var S: String;
begin
  S := 'versao={#AppVersion}' + #13#10 +
    'data=' + GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + #13#10 +
    'config_ok=' + IntToStr(Ord(ConfigOk)) + #13#10 +
    'servico_ok=' + IntToStr(Ord(ServiceOk)) + #13#10 +
    'http_ok=' + IntToStr(Ord(HttpOk)) + #13#10 +
    'porta=' + PanelPort + #13#10 +
    'demo=' + IntToStr(Ord(DemoMode)) + #13#10 +
    'banco=' + DbStatus + #13#10;
  SaveStringToFile(AddBackslash(AppDir) + 'logs\install-status.txt', S, False);
end;

procedure PostInstall;
var
  AppDir, NodeExe, Tool, EnvFile, InFile: String;
  Lines: TArrayOfString;
  Code: Integer;
begin
  AppDir := ExpandConstant('{app}');
  NodeExe := AppDir + '\runtime\node.exe';
  Tool := AppDir + '\tools\configure-env.js';
  EnvFile := AppDir + '\.env';
  ConfigOk := True;
  ServiceOk := False;
  HttpOk := False;
  DbStatus := 'nao-testado';
  DbMessage := '';
  ConfigMessage := '';
  FinishWarnings := '';

  // 1) .env
  if not IsKeep then
  begin
    SetStatus('Gravando a configuração (.env)...');
    InFile := ExpandConstant('{tmp}\op-input.txt');
    WriteInputFile(InFile);
    Code := RunTool(NodeExe, Tool, 'write --env "' + EnvFile + '" --input "' + InFile + '" --app "' + AppDir + '"', Lines);
    DeleteFile(InFile);
    ConfigOk := (Code = 0) and (Lines[0] = 'OK');
    if ConfigOk then
      ReadInfo(Lines)
    else
      ConfigMessage := JoinLines(Lines, 1);
  end
  else if not FileExists(EnvFile) then
  begin
    ConfigOk := False;
    ConfigMessage := 'O arquivo .env não foi encontrado em ' + EnvFile + '.';
  end;
  SecureEnvFiles(AppDir);

  if ConfigOk then
  begin
    Code := RunTool(NodeExe, Tool, 'info --env "' + EnvFile + '"', Lines);
    ConfigOk := (Code = 0) and (Lines[0] = 'OK');
    if ConfigOk then
      ReadInfo(Lines)
    else
      ConfigMessage := JoinLines(Lines, 1);
  end;
  if PanelPort = '' then PanelPort := GetPanelPort('');
  SetIniString('InternetShortcut', 'URL', 'http://localhost:' + PanelPort + '/', AppDir + '\Abrir Oracle Pulse.url');

  // 2) Firewall
  SetStatus('Configurando o Firewall do Windows...');
  ConfigureFirewall(PanelPort, WizardIsTaskSelected('firewall'));

  // 3) Serviço
  SetStatus('Registrando o serviço do Windows ' + SERVICE_NAME + '...');
  ServiceOk := EnsureServiceInstalled(AppDir);
  if ServiceOk and ConfigOk then
  begin
    SetStatus('Iniciando o serviço ' + SERVICE_NAME + '...');
    RunHidden(WrapperExe(AppDir), 'start');
    SetStatus('Aguardando o painel responder em http://localhost:' + PanelPort + ' ...');
    HttpOk := WaitHttp('http://127.0.0.1:' + PanelPort + '/', 45);

    // 4) Teste de conexão com o Oracle (não bloqueia a instalação)
    if HttpOk and not DemoMode and not IsTrueText(ExpandConstant('{param:SKIPDBTEST|0}')) then
    begin
      SetStatus('Testando a conexão com o banco Oracle...');
      Code := RunTool(NodeExe, Tool, 'check-db --env "' + EnvFile + '" --timeout 30', Lines);
      if Lines[0] = 'OK' then DbStatus := 'ok' else DbStatus := 'falha';
      DbMessage := JoinLines(Lines, 1);
    end
    else if DemoMode then
      DbStatus := 'demo';
  end;
  WriteStatusFile(AppDir);

  if not ConfigOk then
    ShowError('A configuração (.env) NÃO foi gravada:' + #13#10#13#10 + ConfigMessage + #13#10#13#10 +
      'O serviço não foi iniciado. Execute o instalador novamente e escolha "Revisar e alterar a configuração".')
  else if not ServiceOk then
    ShowError('Não foi possível registrar o serviço do Windows ' + SERVICE_NAME + '.' + #13#10 +
      'Veja o log da instalação e os arquivos em ' + AppDir + '\logs.')
  else if not HttpOk then
    ShowError('O serviço foi instalado, mas o painel não respondeu em http://localhost:' + PanelPort + '.' + #13#10#13#10 +
      'Verifique os logs em ' + AppDir + '\logs (OraclePulse.err.log / OraclePulse.out.log).' + #13#10 +
      'Causa comum: a porta ' + PanelPort + ' está ocupada por outro programa.')
  else if DbStatus = 'falha' then
    ShowMsg('O painel está no ar, mas o teste de conexão com o Oracle falhou:' + #13#10#13#10 + DbMessage + #13#10#13#10 +
      'O serviço continuará tentando conectar. Para corrigir os dados, execute o instalador novamente ' +
      'e escolha "Revisar e alterar a configuração".', mbInformation, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then PostInstall;
end;

procedure CurPageChanged(CurPageID: Integer);
var S, Host: String;
begin
  if CurPageID <> wpFinished then Exit;
  Host := GetComputerNameString;
  if HttpOk then
    S := 'O Oracle Pulse foi instalado e o serviço ' + SERVICE_NAME + ' está em execução.' + #13#10#13#10 +
      'Acesse:  http://' + Host + ':' + PanelPort + '/' + #13#10 +
      '(nesta máquina: http://localhost:' + PanelPort + '/)' + #13#10#13#10
  else
    S := 'Os arquivos do Oracle Pulse foram instalados, mas o painel NÃO está respondendo. ' +
      'Veja as mensagens exibidas e os logs.' + #13#10#13#10;
  if DbStatus = 'ok' then
    S := S + 'Banco Oracle: ' + DbMessage + #13#10
  else if DbStatus = 'falha' then
    S := S + 'Banco Oracle: FALHA na conexão (o serviço seguirá tentando).' + #13#10
  else if DbStatus = 'demo' then
    S := S + 'Banco Oracle: modo DEMONSTRAÇÃO (dados simulados).' + #13#10;
  if FinishWarnings <> '' then
    S := S + #13#10 + 'Avisos da configuração:' + #13#10 + FinishWarnings;
  S := S + #13#10 + 'Configuração: ' + ExpandConstant('{app}') + '\.env' + #13#10 +
    'Logs: ' + ExpandConstant('{app}') + '\logs';
  WizardForm.FinishedLabel.Caption := S;
  WizardForm.AdjustLabelHeight(WizardForm.FinishedLabel);
  WizardForm.RunList.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(12);
end;

// ============================================================================
// Desinstalação
// ============================================================================

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var AppDir: String;
begin
  AppDir := ExpandConstant('{app}');
  if CurUninstallStep = usUninstall then
  begin
    RemoveDataOnUninstall := IsTrueText(ExpandConstant('{param:REMOVEDATA|0}'));
    if not UninstallSilent then
      RemoveDataOnUninstall := MsgBox('Remover também a configuração (.env, que contém as senhas) e os logs?' + #13#10#13#10 +
        'Escolha "Não" para manter esses arquivos e reaproveitá-los numa reinstalação.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
    StopService(AppDir);
    RemoveService(AppDir);
    RunHidden(SysExe('netsh.exe'), 'advfirewall firewall delete rule name="' + FIREWALL_RULE + '"');
    // Backups agendados pelo painel (tela Backup) apontam para {app}\bin: saem junto.
    RunHidden(PowerShellExe, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-ScheduledTask -TaskPath ''\OraclePulse\'' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false"');
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    if RemoveDataOnUninstall then
    begin
      DeleteFile(AddBackslash(AppDir) + '.env');
      DelTree(AddBackslash(AppDir) + '.env.bak-*', False, True, False);
      DelTree(AddBackslash(AppDir) + 'logs', True, True, True);
    end;
    RemoveDir(AppDir);
  end;
end;
