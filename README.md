# Zorryfy Frontend

Interfaz web para Zorryfy Music Player - Reproductor web con tema Halloween.

## Archivos

- `index.html` - Página principal
- `static/app.js` - Lógica (autenticación, playlists, música)
- `static/app.css` - Estilos Halloween
- `static/halloween.js` - Animaciones interactivas
- `sw.js` - Service Worker (notificaciones Push)

## Configuración

El frontend conecta al backend en:
- **Desarrollo**: `http://localhost:8000`
- **Producción**: Variable de entorno `VITE_API_URL` o `window.location.origin`

## Deploy

Ver opciones en documentación del proyecto principal.
