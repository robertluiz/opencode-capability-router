# Regresión: selección acumulativa de herramientas

Desde la raíz del repositorio, con Node.js 24 o posterior:

```sh
node --test eval/router-compaction.test.mjs
```

El eval simula 20 compactaciones y verifica que la selección sobrevive a nuevas peticiones, nuevas búsquedas y la renovación de la caché del catálogo. También comprueba que no se comparte entre sesiones y que el router no vuelve a ofrecer una herramienta ausente en el catálogo del host.

## Descubrimiento bajo demanda con OpenAI

Esta prueba opcional hace llamadas reales a OpenAI con la autenticación que ya utiliza OpenCode. Solo envía el escenario y los ficheros sintéticos de la prueba. Usa una configuración temporal y desactiva el indexador.

```powershell
$env:ROUTER_EVAL_CLI = 'C:\ruta\a\opencode.exe'
$env:ROUTER_EVAL_MODEL = '<referencia-de-prueba>'
node --test eval/live-discovery.mjs
```

Exige cero búsquedas para una respuesta que no necesita herramientas, una sola para la primera lectura y cero para la segunda, ya disponible en la misma sesión. Las peticiones en portugués cubren la lectura de un log, la consulta de una skill y ambas operaciones en una sola búsqueda sin `kind`. Comprueban la consulta traducida, las restricciones estructuradas, la ruta exacta y qué skill se carga. Las peticiones no indican al modelo cómo rellenar el esquema. Es una prueba de comportamiento para estos escenarios, no una garantía para otras tareas o modelos.

## OpenCode real en Docker

Desde la raíz del repositorio (PowerShell):

```powershell
docker build -t capability-router-compaction-eval ./eval
docker run --rm --network none --mount "type=bind,source=$PWD,target=/router,readonly" capability-router-compaction-eval
```

En WSL, ejecuta los mismos comandos desde la ruta del repositorio accesible desde Linux (`$PWD` debe ser una ruta de WSL). Para construir sin red si ya está disponible la imagen de QA local, añade `--network none --build-arg OPENCODE_IMAGE=router-mcp-qa:isolated` a `docker build`.

El contenedor prueba el código montado en `/router` con OpenCode 2.3.2 por defecto y un proveedor local determinista, sin modelos externos ni credenciales reales. Para probar otra versión, añade, por ejemplo, `--build-arg OPENCODE_IMAGE=ghcr.io/anomalyco/opencode:2.4.1` a `docker build`. El proveedor simula el consumo de tokens; OpenCode realiza las compactaciones y lee el fichero de prueba. El escenario exige al menos 9 compactaciones automáticas, 37 lecturas completadas (una tras un nuevo mensaje), una sola llamada a `find_capabilities` y ningún error de ejecución de herramientas.

## Modelo explícito para el indexador

Desde la raíz del repositorio, con la misma imagen:

```powershell
node --test indexer-model-test.mjs
docker run --rm --network none --mount "type=bind,source=$PWD,target=/router,readonly" capability-router-compaction-eval /eval/indexer-model.mjs
docker run --rm --network none --mount "type=bind,source=$PWD,target=/router,readonly" capability-router-compaction-eval /eval/indexer-model.mjs installed
```

La prueba en Docker configura `agents.indexer.model` con un modelo distinto al de la sesión principal. Usa un endpoint local determinista; verifica el modelo y el destino reales de la petición de indexación, una sesión raíz separada y sin herramientas, y la persistencia de conceptos. El test local cubre también la precedencia del override, el rechazo de cambios de proveedor no autorizados y el caso en que cambiar solo el modelo no dispara una reindexación.

El modo `installed` ejecuta el instalador en un perfil temporal sin indexador configurado. Al abrir OpenCode, un turno del agente predeterminado debe conservar sus herramientas y activar una indexación aislada que hereda la configuración de la sesión.
