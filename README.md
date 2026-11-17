# Norte Gestión

Norte Gestión es el panel interno de Norte AutoCare, una tienda de productos para el cuidado del automóvil. En el mismo proyecto están la tienda, donde el cliente compra y consulta sus pedidos, y el panel donde el equipo gestiona ventas, compras y almacén.

El caso principal empieza cuando un proveedor envía una tarifa nueva. Oficina revisa el documento, Dirección comprueba cómo cambia el margen y decide si acepta el nuevo coste. Si también quiere cambiar el precio en tienda, lo tramita por separado. Así se puede seguir la decisión desde el PDF hasta el historial sin alterar los pedidos anteriores.

## Arrancar en local

Necesitas **Node.js 24.12 o posterior de la rama 24** y npm. Desde la raíz del repositorio:

```sh
npm ci
npm start
```

Deja la terminal abierta y entra en [Tienda](http://127.0.0.1:4317/tienda) o [Gestión](http://127.0.0.1:4317/gestion). En Windows puedes usar `start-local.cmd` después de instalar las dependencias. Si PowerShell bloquea `npm`, escribe `npm.cmd` en los comandos.

Al arrancar se crea la base SQLite en `data/changelab.sqlite` si aún no existe. Consulta [.env.example](.env.example) para configurar el puerto, Ollama o el correo. `CHANGELAB_DB` permite usar otro archivo SQLite.

### Acceso de prueba

En otra terminal, ejecuta `npm run users:create` una vez por cada cuenta. La utilidad pide usuario, nombre, rol y contraseña. Introduce la contraseña dos veces. Los valores de esta tabla son para una base local de prueba y se habilitan al crear las cuentas.

| Usuario          | Nombre              | Rol      | Contraseña de prueba   |
| ---------------- | ------------------- | -------- | ---------------------- |
| prueba-oficina   | Oficina de prueba   | `office` | `Oficina-Local-2026`   |
| prueba-direccion | Dirección de prueba | `owner`  | `Direccion-Local-2026` |

Oficina prepara tarifas, compras y expediciones. Dirección revisa y autoriza cambios comerciales. Puedes crear otra cuenta con rol `warehouse` para comprobar recepciones, preparación y recogidas. [Cuentas locales](docs/cuentas-locales.md) · [Roles de empresa](docs/roles-empresa.md).

## Probar el recorrido de una tarifa

1. Entra en Gestión como **Oficina**. Abre **Tarifas de proveedores → Importar y revisar tarifas**, selecciona **Bruma · Químicos de lavado** y adjunta el [PDF de ejemplo](tests/fixtures/tariff-bruma.pdf). Completa la referencia y el motivo.
2. Abre **Propuestas para Dirección** y prepara la simulación. Busca la referencia `NA-001`. Con la base nueva, el coste pasa de 49,00 € a 52,50 €. Si se mantiene el precio neto de 79,90 €, el margen bruto por unidad baja del 38,67 % al 34,29 %.
3. Entra como **Dirección**, coteja el original y aplica los costes revisados. La oferta del proveedor se actualiza. La simulación anterior queda desactualizada y se puede recalcular. El precio de venta se cambia desde **Propuestas**, con su propia autorización.

## Qué puedes probar

- **Tienda y pedidos.** Consulta el catálogo, añade productos al carrito y sigue las compras en **Mis pedidos**. Si cambia un precio o faltan unidades, el carrito muestra el aviso antes de continuar.
- **Compras y almacén.** Oficina prepara una compra, Dirección la revisa y Almacén registra lo que llega. Se pueden registrar recepciones parciales, roturas y devoluciones.
- **Envíos.** Almacén confirma la preparación, Oficina registra transportista y referencia, y Almacén confirma la recogida.
- **Análisis comercial y propuestas.** Localiza artículos con existencias y sin ventas registradas. Puedes simular un ajuste para un producto o una categoría, o comparar una rebaja, un 3×2, una segunda unidad a mitad de precio y un pack según el stock. La comparación calcula el margen. Las ofertas por cantidad y los packs son escenarios de simulación.
- **Facturación, caja e historial.** Consulta los documentos de prueba, los cobros simulados y los reembolsos registrados. El historial muestra quién hizo cada cambio y cuándo.

## IA local

Con Ollama iniciado, descarga el modelo que usa la aplicación por defecto:

```sh
ollama pull qwen3:4b-instruct
```

La aplicación consulta Ollama en `http://127.0.0.1:11434`. Puedes elegir otro modelo con `CHANGELAB_MODEL`. El modelo ayuda a interpretar peticiones de precio, ordenar opciones comerciales y destacar resultados de una simulación. Los importes se calculan en el servidor y la publicación exige los permisos correspondientes. Si Ollama falla, puedes seguir usando el catálogo, simular cambios manualmente y consultar el resumen de tarifa calculado por reglas. [Configuración de Ollama](docs/ollama-local.md).

## Código y pruebas

| Directorio                    | Contenido                                              |
| ----------------------------- | ------------------------------------------------------ |
| `public/`                     | Interfaz de tienda y gestión en HTML, CSS y JavaScript |
| `src/domain/`                 | Reglas de catálogo, precios y márgenes                 |
| `src/application/`            | Casos de uso, como compras, tarifas y pedidos          |
| `src/infrastructure/`         | Persistencia en SQLite y conexión con Ollama           |
| `src/http/` y `src/server.ts` | Rutas HTTP, sesiones y arranque                        |
| `tests/`                      | Pruebas de reglas, persistencia y API                  |

El servidor usa Node.js y TypeScript. Tienda y Gestión se sirven desde un mismo proceso y comparten la base de datos. [Arquitectura](docs/arquitectura-actual.md) · [Dependencias](docs/dependencias-terceros.md).

```sh
npm run check
npm run evaluate:review
npm run evaluate:operations
```

`check` revisa tipos y formato y ejecuta las pruebas automatizadas. Las evaluaciones de IA requieren Ollama y guardan sus resultados para casos sintéticos en `data/evaluations/`.

## Docker, copias y límites

```sh
docker compose up --build -d --wait
docker compose exec app npm run users:create
```

Con Docker, abre [Gestión](http://127.0.0.1:4320/gestion) o [Tienda](http://127.0.0.1:4320/tienda). Compose usa un volumen propio para SQLite y conecta con Ollama en `host.docker.internal:11434` por defecto. Ejecuta `docker compose stop` cuando termines. [Guía Docker](docs/docker-local.md).

Para la instalación sin Docker, `npm run db:backup` crea una copia verificada. `npm run db:restore -- <carpeta-de-copia> <destino-nuevo>` permite comprobar la restauración en otra ubicación. [Copias y recuperación](docs/copias-locales.md).

La instalación está pensada para uso local. El catálogo inicial es ficticio, los pagos son simulados y los documentos fiscales son de prueba. El correo queda en vista previa con la configuración predeterminada. Los PDF escaneados requieren OCR externo. [Correos y envíos](docs/correos-envios.md).
