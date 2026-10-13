const { app, BrowserWindow, Menu, dialog, ipcMain, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

let win;

function send(cmd, arg) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', cmd, arg);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 980,
    minHeight: 560,
    backgroundColor: '#0b0a1f',
    title: 'SGNAudio 7',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const item = (label, cmd, accelerator) => ({ label, accelerator, click: () => send(cmd) });
  const fx = (label, cmd) => ({ label, click: () => send('fx', cmd) });
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Archivo',
      submenu: [
        item('Abrir audio…', 'open', 'CmdOrCtrl+O'),
        item('Exportar como WAV…', 'export-wav', 'CmdOrCtrl+Shift+E'),
        item('Exportar como MP3…', 'export-mp3', 'CmdOrCtrl+Shift+M'),
        { type: 'separator' },
        item('Nuevo proyecto', 'new', 'CmdOrCtrl+N'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        item('Deshacer', 'undo', 'CmdOrCtrl+Z'),
        item('Rehacer', 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        item('Cortar', 'cut', 'CmdOrCtrl+X'),
        item('Copiar', 'copy', 'CmdOrCtrl+C'),
        item('Pegar', 'paste', 'CmdOrCtrl+V'),
        item('Eliminar selección', 'delete', 'Delete'),
        item('Recortar al área seleccionada', 'trim', 'CmdOrCtrl+T'),
        { type: 'separator' },
        item('Seleccionar todo', 'select-all', 'CmdOrCtrl+A'),
        item('Dividir pista en el cursor', 'split', 'CmdOrCtrl+I'),
      ],
    },
    {
      label: 'Efectos',
      submenu: [
        fx('Fundido de entrada', 'fade-in'),
        fx('Fundido de salida', 'fade-out'),
        fx('Amplificar…', 'amplify'),
        fx('Normalizar', 'normalize'),
        fx('Invertir (al revés)', 'reverse'),
        fx('Silenciar selección', 'silence'),
        fx('Invertir fase', 'invert'),
        { type: 'separator' },
        fx('Reducción de ruido (puerta)…', 'noise-gate'),
        fx('Eco…', 'echo'),
        fx('Cambiar velocidad…', 'speed'),
        fx('Graves (Bass Boost)', 'bass'),
        fx('Compresor suave', 'compress'),
      ],
    },
    {
      label: 'Pista',
      submenu: [
        item('Nueva pista vacía', 'new-track'),
        item('Duplicar pista', 'dup-track'),
        item('Eliminar pista', 'del-track'),
      ],
    },
    {
      label: 'Ver',
      submenu: [
        item('Acercar', 'zoom-in', 'CmdOrCtrl+='),
        item('Alejar', 'zoom-out', 'CmdOrCtrl+-'),
        item('Ajustar todo a la ventana', 'zoom-fit', 'CmdOrCtrl+0'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [item('Atajos de teclado', 'shortcuts'), item('Acerca de SGNAudio 7', 'about')],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir audio',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) }));
});

ipcMain.handle('save-dialog', async (_e, { defaultName, ext, data }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Exportar audio',
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return r.filePath;
});

ipcMain.handle('mic-permission', async () => {
  if (process.platform === 'darwin') {
    try { return await systemPreferences.askForMediaAccess('microphone'); } catch { return false; }
  }
  return true;
});

ipcMain.handle('read-lame', async () => {
  const p = path.join(__dirname, '..', 'node_modules', 'lamejs', 'lame.min.js');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
