# ✨ AR Magic Draw

Dibuja en el aire con las manos. La cámara detecta los 21 puntos de cada mano
con MediaPipe y cada yema deja un trazo de neón que se desvanece solo.

Todo cabe en un único archivo (`index.html`): sin build, sin dependencias que
instalar, sin backend. El vídeo nunca sale del navegador.

---

## Cómo ejecutarlo

La cámara exige un contexto seguro, así que **no basta con abrir el archivo**
haciendo doble clic (`file://`). Sirve la carpeta por HTTP:

```bash
python3 -m http.server 8000
```

Y abre <http://localhost:8000>.

También vale cualquier alternativa (`npx serve`, `php -S localhost:8000`, la
extensión Live Server de VS Code…) o publicarlo en cualquier hosting estático
con HTTPS.

**Requisitos:** un navegador moderno con WebGL y `getUserMedia` (Chrome, Edge,
Safari o Firefox actualizados) y una cámara. La primera carga descarga el
modelo de detección (~8 MB) desde el CDN, así que necesita internet.

---

## Cómo se dibuja

Muestra la mano abierta frente a la cámara. Hay tres modos, en la barra
superior:

| Modo | Qué hace |
| --- | --- |
| **5 Dedos** | Cada dedo **estirado** pinta con su propio color. Dobla un dedo y ese trazo se levanta. |
| **Índice** | Solo pinta el índice. Más limpio para escribir. |
| **Pellizco** | Pinta solo mientras juntas el pulgar y el índice, desde el punto medio entre ambos. |

**Cierra el puño** durante un instante para borrar el lienzo.

Detecta hasta **dos manos** a la vez, cada una con sus cinco trazos
independientes.

### Atajos de teclado

| Tecla | Acción |
| --- | --- |
| `C` | Limpiar el lienzo |
| `M` | Efecto espejo |
| `F` | Pantalla completa |
| `H` | Ocultar o mostrar la interfaz |
| `S` | Guardar una foto PNG |
| `R` | Empezar o parar la grabación |
| `Espacio` | Congelar (desactiva el desvanecimiento) |
| `1` `2` `3` | Cambiar de modo |

La interfaz se esconde sola a los 4 segundos de inactividad — útil si lo
proyectas.

---

## Ajustes

En el panel de la rueda dentada:

- **Desvanecimiento** — cuánto vive cada trazo, de 0.5 a 20 s.
- **Grosor** y **Resplandor** del pincel.
- **Suavizado** — de *crudo* (reactivo, con algo de temblor) a *alto* (muy
  suave, con un pelín de retardo).
- **Opacidad del vídeo** — bájala a 0 para dibujar sobre negro puro.
- **Espejo**, **Chispas** en la punta y **Cola fina** (el trazo adelgaza hacia
  el final).
- **Calidad** — Alta / Media / Baja. Baja el nivel si te faltan FPS: reduce la
  resolución interna y el número de capas del resplandor.
- **Cámara** — selector, por si tienes más de una.
- **Paleta** — Neón, Fuego, Hielo, Arcoíris o un color por dedo a tu gusto.

Todo se guarda en `localStorage`, así que la próxima vez arranca como lo
dejaste.

### Congelar

Con **❄ Congelar** el trazo deja de desvanecerse y el lienzo se comporta como
una pizarra: útil para escribir una palabra entera o dibujar algo con calma.

### Foto y vídeo

- **📷** guarda un PNG.
- **⏺** graba un WebM y lo descarga al parar.

Ambos exportan lo mismo que ves —vídeo de fondo y trazos ya compuestos, y con
el espejo aplicado en el sentido correcto— porque todo se pinta sobre un único
canvas.

---

## Cómo funciona

- **Detección:** [`@mediapipe/tasks-vision`][tv] (`HandLandmarker`), fijado a la
  versión 0.10.14. Intenta usar la GPU y cae a CPU si no puede.
- **Un solo canvas.** El vídeo y los trazos se pintan en el mismo `<canvas>`,
  lo que hace que capturar una foto o grabar sea inmediato.
- **Coordenadas.** Los puntos se guardan normalizados respecto a la cámara y se
  proyectan en cada frame, así que redimensionar la ventana no deforma lo ya
  dibujado. El mapeo replica el recorte `cover` del vídeo, de modo que el trazo
  siempre cae justo bajo la yema.
- **Suavizado.** Los landmarks de MediaPipe tiemblan unos píxeles por frame. Un
  filtro [One Euro][oe] por yema limpia ese ruido cuando la mano está quieta
  sin añadir retardo cuando se mueve rápido.
- **Resplandor.** En lugar de `shadowBlur` —carísimo sobre trazos largos— el
  brillo se construye con varias pasadas de distinto grosor y opacidad en modo
  `lighter`. Además, los cruces de trazos suman luz en vez de ensuciarse.
- **Desvanecimiento.** Cada trazo se reparte en bandas por antigüedad y cada
  banda se dibuja con su propia opacidad y grosor. Así la cola se disuelve de
  verdad, con un puñado de llamadas de dibujo en vez de una por segmento.
- **Gestos.** Un dedo cuenta como estirado si la punta está más lejos de la
  muñeca que su nudillo medio; medirlo así funciona con la mano girada, cosa
  que no ocurre comparando alturas. Las dos manos se distinguen por la etiqueta
  de lateralidad de MediaPipe, no por su posición en el array, que cambia de un
  frame a otro.

[tv]: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js
[oe]: https://gery.casiez.net/1euro/

---

## Notas y limitaciones

- Los umbrales de los gestos (cuándo un dedo cuenta como estirado, cuándo un
  pellizco cuenta como cerrado) son valores por defecto razonables, pero puede
  que quieras afinarlos: están en `isExtended()` e `isPinching()`.
- Necesita luz decente. A contraluz o en penumbra la detección se vuelve
  intermitente.
- La grabación produce WebM, que Safari no siempre reproduce de forma nativa.
- El modelo y el runtime se cargan desde jsDelivr y Google Storage. Si lo
  quieres offline o en un kiosco sin red, descarga esos archivos y cambia las
  constantes `VISION_WASM` y `MODEL_URL`.
