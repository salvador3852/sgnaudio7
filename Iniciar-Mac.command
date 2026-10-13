#!/bin/bash
# Abre SGNAudio 7 en tu Mac (doble clic)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Necesitas instalar Node.js (versión LTS) desde https://nodejs.org y volver a abrir este archivo."
  open "https://nodejs.org"; read -p "Pulsa Enter para cerrar..."; exit 1
fi
[ -d node_modules ] || npm install
npm start
