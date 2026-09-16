# iPhone Camera Monitor

Monitor en vivo de la camara trasera del iPhone en una pantalla de Windows, con
grabacion en la PC controlada por gestos de mano. Misma red local, sin apps
nativas y sin Xcode.

El iPhone entra por Safari a una pagina servida desde esta PC, pide la camara
con `getUserMedia` y manda el video por **WebRTC** directo a la PC. El servidor
Node solo hace de *signaling*: intercambia SDP e ICE. **El video nunca pasa por
el servidor**, va peer-to-peer.

## Arranque

```bash
npm install      # baja tambien el modelo de gestos (~8 MB)
npm start
```

- **PC** (Chrome/Edge): `https://localhost:3000/monitor.html`
- **iPhone** (Safari, misma red): `https://<IP-DE-LA-PC>:3000/phone.html`

El servidor imprime las dos URLs con la IP ya resuelta. Tocá una vez la pantalla
del iPhone (Safari exige un gesto del usuario para dar la camara) y en 1-2
segundos aparece el feed.

## Gestos

Se hacen **a la camara del telefono**, y los lee la PC sobre el video que
recibe:

| gesto | accion |
| --- | --- |
| palma abierta (high five) | empezar una toma; si ya hay una grabando, la reinicia |
| pulgar arriba | guardar la toma |
| pulgar abajo | descartar la toma |

Hay que **sostener el gesto 700 ms**: una mano que pasa tocando delante de la
camara no dispara nada. La barra abajo a la izquierda muestra cuanto falta.
Despues de disparar hay 1,5 s de enfriamiento, y para repetir el mismo gesto
hay que soltarlo primero.

Los mismos comandos por teclado, para probar sin ponerse delante de la camara:
`R` empezar/reiniciar, `G` guardar, `D` descartar.

El modelo es el **Gesture Recognizer** de MediaPipe, que ya trae entrenadas
`Open_Palm`, `Thumb_Up` y `Thumb_Down`. No hay clasificador propio.

**Corre en la PC, no en el iPhone**, a proposito: el telefono ya esta
capturando y codificando H.264, y sumarle inferencia lo calienta y lo hace
bajar la calidad del video que justamente queremos mirar. Ademas la grabacion
vive en la PC, asi que gesto y grabacion quedan del mismo lado.

## Grabacion

Las tomas se guardan en `grabaciones/`, **en la PC**, como
`toma-2026-09-12_16-04-31.mp4`: H.264 en un MP4 con el indice adelante, que es
lo que DaVinci Resolve y cualquier editor esperan (ver mas abajo por que hace
falta convertirlo).

Los trozos del `MediaRecorder` salen por WebSocket a medida que se generan y el
servidor los escribe a disco en un archivo `.parcial-*`, que se renombra al
guardar y se borra al descartar. No se junta el video entero en memoria: una
toma de varios minutos a 12 Mbps son cientos de MB. Si la pestaña se cierra en
medio de una toma, el parcial se borra solo.

`GET /api/grabaciones` lista lo que hay guardado.

### Por que la toma se remuxea al cerrarse

El `MediaRecorder` con `video/mp4;codecs=avc1` **no escribe un MP4 normal**:
escribe un **MP4 fragmentado** (fMP4). No tiene alternativa, porque va emitiendo
el archivo de a trozos sin saber cuanto va a durar la toma.

```
fragmentado:  ftyp | moov (vacio, duration=0) | moof+mdat | moof+mdat | ...
normal:       ftyp | moov (indice completo)   | mdat
```

En el fragmentado el `moov` no trae la tabla de muestras (`stbl`: stts/stsz/
stco): **no hay indice**, y la duracion real esta repartida en cada `moof`.
Medido sobre una toma cruda, el `moov` declara `duration=0` y `ffprobe` devuelve
`nb_frames=N/A`. Un reproductor de streaming lo tolera; **DaVinci Resolve no
importa fMP4** y lo reporta como archivo dañado.

Por eso, al guardar, `remux.js` pasa el parcial por ffmpeg:

```bash
ffmpeg -i parcial.mp4 -c copy -movflags +faststart toma.mp4
```

Es un **remux, no una recodificacion**: se reescriben las cajas con el indice
completo adelante y se copian los mismos paquetes H.264 tal cual. No se pierde
un solo bit de calidad, y tarda decimas de segundo (medido: 0,14 s).

Si el navegador cayo al respaldo WebM, ahi si hay que recodificar a H.264:
Resolve tampoco lee WebM y VP9 no entra en un MP4 copiando.

**Hace falta ffmpeg en el PATH** (`winget install Gyan.FFmpeg`, o la variable
`FFMPEG` apuntando al binario). Si no esta, el servidor avisa al arrancar y en
cada toma, y guarda el crudo sin convertir antes que perderla.

## Pasar archivos entre el telefono y la PC

`https://<IP-DE-LA-PC>:3000/transferir.html` (tambien desde el boton
**Transferencias** del monitor). Es una carpeta compartida, `transferencias/`,
y **va para los dos lados**: lo que sube el telefono aparece ahi, y lo que se
deja ahi desde la PC aparece en la lista del telefono para bajar. En la PC
tambien se pueden arrastrar archivos a la pagina.

Reemplaza el viaje por WeTransfer, que es lento no por el archivo sino por el
camino: sube el video entero a un servidor en internet y despues lo baja. Aca
los bytes van directo de un aparato al otro por la red local, **sin recomprimir
nada** (medido: mismo SHA-256 en las dos puntas).

**Lo que si puede tocar la calidad pasa antes de que el archivo salga del
telefono**: en *Ajustes -> Fotos -> Transferir a Mac o PC*, la opcion
"Automatico" convierte los HEVC a H.264 al exportarlos. Hay que ponerlo en
**"Conservar originales"**; desde el servidor no hay forma de impedirlo.

Detalles que importan:

- El archivo viaja como **cuerpo crudo del POST**, con el nombre en un header, y
  no como `multipart/form-data`: asi se puede mandar a disco a medida que llega
  y un video de varios GB nunca entra en memoria.
- Se usa `XMLHttpRequest` y no `fetch` porque **fetch no informa el progreso de
  subida**, y sin barra un video grande parece colgado.
- `server.requestTimeout = 0`: Node corta solo cualquier pedido que pase de 5
  minutos, y una subida grande los pasa de largo.
- Se escribe en `.subiendo-*` y se renombra al terminar, para que una subida
  cortada no deje un archivo truncado con pinta de sano.
- La pagina pide **wake lock** mientras sube: si la pantalla del iPhone se
  bloquea, iOS suspende Safari y corta la subida.
- El nombre que manda el telefono nunca se usa tal cual (`../../` en el nombre
  dejaria escribir fuera de la carpeta).

## Por que HTTPS y no HTTP

Safari en iOS entrega `getUserMedia` unicamente en un *secure context*: `https`,
o `localhost`. **Una IP de LAN sobre `http://` no cuenta** — `navigator.mediaDevices`
viene `undefined` y la pagina no pide la camara nunca.

Por eso `server.js` genera un certificado autofirmado en el primer arranque
(paquete `selfsigned`, JS puro) y lo deja en `certs/`. El `subjectAltName`
incluye `localhost`, `127.0.0.1` y **cada IP de LAN de la PC**: si el
certificado no nombra la IP por la que entras, Safari lo rechaza sin ofrecer
siquiera el "visitar de todas formas".

Si cambias de red o el DHCP te da otra IP, detecta que el certificado ya no la
cubre y lo regenera solo.

Cada dispositivo avisa una vez que el certificado no es de confianza:

- Chrome/Edge: *Configuracion avanzada -> Continuar a ...*
- Safari: *Mostrar detalles -> visitar este sitio web*

## Cuando se corta

Se reconecta solo; no hay que recargar nada a mano.

La causa mas comun **no es la WiFi**: en iOS alcanza con que la pantalla se
bloquee o Safari pase a segundo plano para que el sistema suspenda la pagina y
mate la camara. Desde el otro lado se ve identico a una caida de red. Por eso
la pagina del telefono pide *wake lock* de pantalla mientras transmite, y lo
vuelve a pedir al reaparecer (iOS lo suelta al pasar a segundo plano y no lo
devuelve por su cuenta).

Lo demas que sostiene la conexion:

- WebSocket con reintento de espera geometrica (500 ms a 5 s) y reconexion
  inmediata al volver de `visibilitychange`, `online` y `pageshow`.
- La camara se pide **una sola vez** y sobrevive a las caidas: al reconectar se
  rearma la `RTCPeerConnection` con el stream que ya estaba, sin volver a pedir
  permiso.
- El servidor avisa a cada lado cuando el otro entra o sale, para que el
  telefono sepa cuando volver a ofrecer. Sin eso el monitor espera para siempre
  una oferta que nadie va a mandar.
- Ping/pong cada 15 s: un iPhone dormido dejaba un socket fantasma que el
  servidor seguia creyendo vivo.

El servidor registra cada pedido, cada apertura y cierre de socket con su
codigo y motivo, y los sockets que no contestan el ping. Si algo se corta, la
consola dice que paso.

## Firewall

Si el iPhone no llega a la pagina, casi siempre es el Firewall de Windows: en
el perfil **publico** bloquea las conexiones entrantes. Dos salidas, cualquiera
sirve, **las dos necesitan PowerShell como administrador**:

```powershell
# A) marcar la red como privada (lo mas limpio)
Set-NetConnectionProfile -Name "<nombre de tu red>" -NetworkCategory Private

# B) o abrir solo el puerto 3000
New-NetFirewallRule -DisplayName "iphone-monitor 3000" -Direction Inbound `
  -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any
```

## Calidad

Con `S` en la pagina del monitor se abre el panel de estadisticas: resolucion y
fps reales que llegan, bitrate, codec negociado, perdida, jitter y cuadros
descartados. Son los numeros de la sesion, no lo que pedimos en las
constraints.

El emisor pide `maxBitrate` de 12 Mbps y `degradationPreference:
maintain-resolution`. El default de WebRTC esta pensado para internet (un par
de Mbps) y ante congestion prefiere bajar resolucion; mirando encuadre uno
quiere lo contrario.

La captura se pide en 1080p30. Para elegir una lente trasera concreta (ultra
wide / tele) hay que usar `enumerateDevices()` y pasar el `deviceId` exacto en
vez de `facingMode`.

## Estructura

```
server.js                  estaticos + signaling + certificado + grabaciones
scripts/bajar-modelos.mjs  baja el modelo de gestos (URL versionada)
shared/config.js           ICE servers
shared/socket.js           WebSocket que se reconecta solo + wake lock
public/phone.html|js       pagina del iPhone (emisor)
public/monitor.html|js     pagina de la PC (receptor, gestos, grabacion)
public/gestos.js           MediaPipe Gesture Recognizer
public/grabacion.js        MediaRecorder -> WebSocket -> disco
public/transferir.*        pasar archivos entre el telefono y la PC
remux.js                   cierra la toma como MP4 editable (ffmpeg)
transferencias.js          carpeta compartida (subida/bajada por la LAN)
modelos/                   modelo .task (gitignoreado)
grabaciones/               las tomas (gitignoreado)
transferencias/            la carpeta compartida (gitignoreada)
```

El servidor sirve `/shared`, `/vendor` (MediaPipe desde `node_modules`, no
desde un CDN: anda sin internet y la version queda clavada por
`package-lock`) y `/modelos`.

## Problemas comunes

- **`OverconstrainedError`**: la lente trasera no da esa combinacion de
  restricciones. `phone.js` ya reintenta solo, aflojando la resolucion.
- **El preview del telefono queda negro**: tocá el cartel de estado y muestra
  `videoWidth`, `readyState`, `paused` y el estado del socket.
- **No conecta**: ver la seccion de Firewall.
- **`npm audit`** marca 2 vulnerabilidades moderadas en `qs`, que entra por
  Express 4. Son DoS via query strings raras; esto sirve archivos estaticos en
  la LAN. Se limpia migrando a Express 5.

## Alcance

Esto monitorea y graba, pero no juzga el encuadre: no hay silueta, plantilla ni
modelo de pose. Eso es otro proyecto (GuitarCam).
