# Usarlo con un teléfono Android

El emisor (`phone.html`) usa WebRTC y `getUserMedia` estándar, sin nada exclusivo de iOS, así que
debería andar en **Chrome para Android** igual que en Safari. Todavía no se probó con un Android real.

1. Teléfono y PC en la misma WiFi. En la PC: `npm start` (imprime las URLs con la IP).
2. En el Android, con Chrome: `https://<IP-de-la-PC>:3000/phone.html`.
3. El certificado es autofirmado: Chrome muestra "La conexión no es privada" →
   **Configuración avanzada → Acceder a <IP> (sitio no seguro)**. Tiene que ser `https`: con `http`
   el navegador no entrega la cámara.
4. Tocar la pantalla una vez y aceptar cámara y micrófono.
5. En la PC: `https://localhost:3000/monitor.html`.

Si no conecta, es lo mismo que con iPhone: el firewall de Windows con la red marcada como "pública"
bloquea el puerto 3000 (ver el README). Si la cámara que abre no es la trasera, o el micrófono suena
procesado (Android también puede meter cancelación de eco y control automático de ganancia), anotarlo
con el modelo del teléfono para ajustarlo en `public/phone.js`.

Para pasar archivos: `https://<IP-de-la-PC>:3000/transferir.html` funciona igual en Android.
