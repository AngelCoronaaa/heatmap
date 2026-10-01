# Heatmap Wi‑Fi

Planificador y site survey Wi‑Fi al estilo Ekahau, con mapas de calor sobre un **plano de planta** (con mapa) o sobre un **lienzo en blanco con medidas** (sin mapa). Interfaz minimalista en azul midnight y servidor en Node.js sin dependencias.

## Requisitos

- Node.js 18 o superior

## Uso

```bash
npm start          # http://localhost:3000
npm run dev        # reinicia el servidor al cambiar archivos
npm test           # pruebas del modelo de propagación y de la API
```

Variables de entorno:

| Variable   | Por defecto       | Descripción                                                  |
|------------|-------------------|--------------------------------------------------------------|
| `PORT`     | `3000`            | Puerto HTTP                                                  |
| `HOST`     | `127.0.0.1`       | Usa `0.0.0.0` para abrirlo desde otros equipos de la red     |
| `DATA_DIR` | `data/projects`   | Carpeta donde se guardan los proyectos (JSON + imagen)       |

## Funciones

- **Dos modos de proyecto**
  - *Con mapa*: sube un plano (PNG, JPG, WebP o SVG), indica su ancho real y afina con la herramienta de calibración.
  - *Sin mapa*: lienzo con cuadrícula métrica de las dimensiones que indiques. Puedes cargar un plano después (o quitarlo) sin perder APs ni muros.
- **Diseño predictivo**: coloca APs (banda 2.4/5/6 GHz, canal, ancho, potencia, ganancia) y dibuja muros con materiales que atenúan distinto según la banda.
- **Vistas del mapa de calor**: Señal (RSSI), SNR, Velocidad estimada, Interferencia co‑canal, Cobertura (APs ≥ señal requerida), Zonas por AP dominante y Medido.
- **Site survey**: marca puntos de medición en el plano. El servidor Node lee el RSSI real de la interfaz Wi‑Fi del equipo donde corre (macOS, Linux y Windows); también puedes capturarlo a mano. Las mediciones se interpolan (IDW) en la vista *Medido*.
- **Optimizar canales**: reasigna canales sin solapamiento para minimizar la interferencia co‑canal.
- Resumen de cobertura, tooltip con valores bajo el cursor, deshacer/rehacer, autoguardado y exportación a PNG (con leyenda) y JSON (incluye el plano, para importar en otro equipo).

## Atajos

| Tecla | Acción | Tecla | Acción |
|---|---|---|---|
| `V` | Seleccionar / mover | `1`–`7` | Cambiar vista |
| `A` | Colocar AP | `F` | Ajustar a la vista |
| `W` | Dibujar muros (`Shift` = 45°) | `Supr` | Borrar selección |
| `M` | Punto de medición | `Ctrl/⌘ Z` | Deshacer (`Shift` para rehacer) |
| `S` | Calibrar escala | `Ctrl/⌘ D` | Duplicar AP |
| `E` | Borrar | `Espacio` + arrastrar | Desplazar |

## Modelo de propagación

Pérdida log‑distance: `RSSI = EIRP − FSPL(1 m, f) − 10·n·log10(d) − Σ muros`, con `n` según el entorno (abierto 2.0, oficina 2.6, denso 3.1) y atenuación por material y banda (tablaroca, vidrio, madera, ladrillo, concreto, metal). La velocidad se estima a partir del SNR con la tabla MCS de 802.11ax a 2 flujos espaciales. Es un modelo predictivo de planificación: valida siempre con mediciones en sitio.

## Estructura

```
server/
  index.js      servidor HTTP: archivos estáticos + API REST
  store.js      persistencia de proyectos en disco
  wifi.js       lectura del RSSI (system_profiler, /proc/net/wireless o nmcli, netsh)
public/
  index.html, css/styles.css
  js/app.js            interfaz: inicio, paneles, guardado, exportación
  js/editor.js         lienzo: pan/zoom, herramientas y dibujo
  js/propagation.js    modelo de RF (compartido con el worker y las pruebas)
  js/heatmap-worker.js cálculo de la rejilla en un Web Worker
  js/colors.js         escalas de color y vistas
test/                  pruebas con node:test
```

### API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/projects` | Lista de proyectos |
| `POST` | `/api/projects` | Crear proyecto |
| `GET` / `PUT` / `DELETE` | `/api/projects/:id` | Leer, guardar o eliminar |
| `GET` / `PUT` / `DELETE` | `/api/projects/:id/background` | Imagen del plano (PNG, JPEG o WebP) |
| `GET` | `/api/wifi` | RSSI actual del adaptador Wi‑Fi del servidor |
