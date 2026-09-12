# iPhone Camera Monitor

Monitor en vivo de la camara trasera del iPhone en una pantalla de Windows, misma
red local. Sin apps nativas, sin Xcode.

El iPhone entra por Safari a una pagina servida desde esta PC, pide la camara con
`getUserMedia` y manda el video por **WebRTC** directo a la PC. El servidor Node
solo hace de *signaling*: intercambia SDP e ICE. **El video nunca pasa por el
servidor**, va peer-to-peer.

## Arranque

```bash
npm install
npm start
```

- **PC** (Chrome/Edge): `https://localhost:3000/monitor.html`
- **iPhone** (Safari, misma WiFi): `https://<IP-DE-LA-PC>:3000/phone.html`

El servidor imprime las dos URLs con la IP ya resuelta. Tocá una vez la pantalla
del iPhone (Safari exige un gesto del usuario para dar la camara) y en 1-2
segundos aparece el feed.

## Por que HTTPS y no HTTP

Safari en iOS entrega `getUserMedia` unicamente en un *secure context*: `https`,
o `localhost`. **Una IP de LAN sobre `http://` no cuenta** — `navigator.mediaDevices`
viene `undefined` y la pagina no pide la camara nunca.

Por eso `server.js` genera un certificado autofirmado en el primer arranque
(paquete `selfsigned`, JS puro) y lo deja en `certs/`. El `subjectAltName`
incluye `localhost`, `127.0.0.1` y **cada IP de LAN de la PC**: si el
certificado no nombra la IP por la que entras, Safari lo rechaza sin ofrecer
siquiera el "visitar de todas formas".

Si cambias de WiFi o el DHCP te da otra IP, detecta que el certificado ya no la
cubre y lo regenera solo.

Cada dispositivo avisa una vez que el certificado no es de confianza:

- Chrome/Edge: *Configuracion avanzada -> Continuar a ...*
- Safari: *Mostrar detalles -> visitar este sitio web*

## Firewall (esto es lo que falla primero)

Si el iPhone no llega a la pagina, casi siempre es el Firewall de Windows.

Esta red esta clasificada como **publica**, y en ese perfil Windows bloquea las
conexiones entrantes. Hay dos salidas, cualquiera sirve, y **las dos necesitan
PowerShell como administrador**:

```powershell
# A) marcar la WiFi como privada (lo mas limpio)
Set-NetConnectionProfile -Name "<nombre de tu WiFi>" -NetworkCategory Private

# B) o abrir solo el puerto 3000
New-NetFirewallRule -DisplayName "iphone-monitor 3000" -Direction Inbound `
  -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any
```

Para comprobar desde el iPhone que el puerto llega, abri `https://<IP>:3000/monitor.html`
en Safari: si carga la pagina negra, la red esta bien y el problema es otro.

## Estructura

```
server.js          servidor: estaticos + signaling WebSocket + certificado
shared/config.js   ICE servers y nombre del room (compartido por las 3 partes)
public/phone.html  pagina del iPhone (emisor)
public/phone.js
public/monitor.html pagina de la PC (receptor)
public/monitor.js
```

El servidor tambien sirve `/shared`, porque `phone.js` y `monitor.js` importan
`../shared/config.js` y el navegador lo pide como `/shared/config.js`.

El signaling **encola** los mensajes destinados a un peer que todavia no se
conecto. Sin eso, si abris el iPhone antes que el monitor, la oferta y los
candidatos ICE se pierden y no conecta nunca.

## Problemas comunes

- **`OverconstrainedError`**: la lente trasera no da esa combinacion de
  restricciones. `phone.js` ya reintenta solo, aflojando la resolucion.
- **No conecta**: los dos dispositivos tienen que estar en la MISMA WiFi. Ver
  la seccion de Firewall.
- **Elegir una lente trasera concreta** (ultra wide / tele / principal): en vez
  de `facingMode`, hace `enumerateDevices()`, filtra por `kind === "videoinput"`
  y pasa ese `deviceId` exacto al `getUserMedia`.
- **`npm audit`** marca 2 vulnerabilidades moderadas en `qs`, que entra por
  Express 4. Son DoS via query strings raras; esto sirve archivos estaticos en
  la LAN y no usa query strings. Se limpia migrando a Express 5.

## Controles del monitor

Doble click o `F` para pantalla completa.

## Alcance

Esto solo monitorea, no graba. Para grabar desde la PC se agrega `MediaRecorder`
sobre `remote.srcObject` en `monitor.js`. Para el gesto de "high five", MediaPipe
Hands corre en `phone.js` sobre el stream local y avisa por el WebSocket; no hay
que tocar nada de la arquitectura de video.
