#!/bin/bash
# Crea el instalador .dmg de SGNAudio 7 (doble clic). El resultado queda en la carpeta "dist".
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Necesitas instalar Node.js (versión LTS) desde https://nodejs.org y volver a abrir este archivo."
  open "https://nodejs.org"; read -p "Pulsa Enter para cerrar..."; exit 1
fi
npm install && npm run build:mac && open dist
read -p "Listo. Pulsa Enter para cerrar..."
