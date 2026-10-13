# SGNAudio 7

Editor y grabador de audio multipista para **Windows** y **Mac**.
**Desarrollado por Salvador G. Núñez.**

## Uso rápido en tu computadora (sin saber programar)

El ZIP no se "pega" en ningún sitio: es la carpeta del proyecto. Descomprímela y:

1. Instala **Node.js** (versión LTS) desde https://nodejs.org (solo una vez).
2. **Mac:** doble clic en `Iniciar-Mac.command` para abrir la app.
   Si macOS lo bloquea: clic derecho → Abrir.
   **Windows:** doble clic en `Iniciar-Windows.bat`.
3. Para crear un **instalador** descargable: `Crear-Instalador-Mac.command` (genera el .dmg en la carpeta `dist`)
   o `Crear-Instalador-Windows.bat` (genera el .exe). El .dmg se crea en un Mac y el .exe en un PC con Windows;
   si no tienes ambos equipos, usa GitHub Actions (más abajo).

## Qué incluye

- Grabación desde el micrófono y vista en vivo del nivel de entrada
- Abrir MP3, WAV, OGG, FLAC, M4A… (también arrastrando archivos a la ventana)
- Multipista: silenciar (M), solo (S), volumen por pista, duplicar y dividir
- Forma de onda con zoom, selección con el ratón y repetición de la selección
- Cortar, copiar, pegar, eliminar, recortar, deshacer/rehacer (60 pasos)
- Efectos: fundido de entrada/salida, amplificar, normalizar, al revés, silencio, invertir fase, reducción de ruido, eco, velocidad, graves y compresor
- Exportar la mezcla a **WAV** y **MP3**

## Probar la app en tu computadora

Necesitas [Node.js 20 o superior](https://nodejs.org).

```bash
npm install
npm start
```

## Publicar la landing con los dos botones (gratis, sin saber programar)

1. Crea una cuenta gratis en github.com y un repositorio **público** llamado `sgnaudio7`.
2. En el repositorio: **Add file → Upload files** y arrastra el contenido de esta carpeta
   (en Finder pulsa `Cmd+Shift+.` para ver la carpeta oculta `.github`, selecciona todo con `Cmd+A` y arrastra).
3. Pestaña **Actions → Compilar SGNAudio 7 → Run workflow**. En unos 10 minutos crea los instaladores de Windows y Mac.
4. **Settings → Pages →** Branch `main`, carpeta `/docs` → Save.
5. Tu landing queda en `https://TU_USUARIO.github.io/sgnaudio7/` — compártela. Los botones se configuran solos.

## Aviso sobre la firma de los instaladores

Los instaladores generados no están firmados con certificados de pago, por lo que:

- **Windows** mostrará SmartScreen: «Más información» → «Ejecutar de todas formas».
- **Mac** pedirá confirmación la primera vez: clic derecho sobre la app → «Abrir».

Para eliminar estos avisos hace falta un certificado de firma de código (Windows) y la cuenta Apple Developer (Mac, ~99 USD/año).

## Estructura

```
src/        código de la aplicación (main.js, app.js, index.html, styles.css)
build/      logo e icono
docs/        página de descarga
.github/    compilación automática para Windows y Mac
```
