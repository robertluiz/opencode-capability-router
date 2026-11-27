# Cobertura funcional y evaluaciones

| Funcionalidad | Evidencia |
| --- | --- |
| Descubrimiento léxico de herramientas, skills, MCP, comandos y agentes; exposición, permisos y delegación | `tests/router-compaction.test.mjs` |
| Descubrimiento semántico, alcance y exclusiones | `tests/semantic-discovery.test.mjs` |
| Indexación aislada, elección de modelo y rechazo de resultados inválidos | `tests/indexer-model.test.mjs`, `eval/docker-indexer-model.mjs` |
| Persistencia, aislamiento de índices y compatibilidad con datos anteriores | `tests/storage.test.mjs` |
| Reutilización de herramientas tras compactación y en mensajes posteriores | `tests/router-compaction.test.mjs`, `eval/docker-compaction.mjs` |
| Elección de una skill entre tres y finalización de la tarea | `eval/live-discovery.mjs` (opcional, con modelo real) |

La prioridad es cubrir el comportamiento del plugin, luego comprobar la instalación y la carga por versión de OpenCode y, por último, ampliar la cobertura de los instaladores por sistema operativo. Las pruebas locales y las evaluaciones en Docker no son una matriz de todos los sistemas y versiones.

Cada workflow por versión ejecuta la suite funcional de Node y tres evaluaciones con el binario real de OpenCode en Docker: compactación, instalación limpia con indexación heredada e indexación con un modelo explícito. La suite de Node usa dobles; son las evaluaciones las que verifican la integración con cada versión. La evaluación con un modelo real se ejecuta aparte y no bloquea la CI.

La CI fija 2.2.0 como versión mínima. Para 2.3.x y 2.4.x, consulta las versiones publicadas de `@opencode/cli` y selecciona el parche estable más alto en cada ejecución, incluida la ejecución programada. La auditoría de imágenes usa las mismas series.

## Regresión: selección acumulativa de herramientas

Desde la raíz del repositorio, con Node.js 24 o posterior:

```sh
node --test tests/router-compaction.test.mjs
```

El eval simula 20 compactaciones y verifica que la selección sobrevive a nuevas peticiones, nuevas búsquedas y la renovación de la caché del catálogo. También comprueba que no se comparte entre sesiones y que el router no vuelve a ofrecer una herramienta ausente en el catálogo del host.

## Descubrimiento bajo demanda con OpenAI

Esta prueba opcional hace llamadas reales a OpenAI con la autenticación que ya utiliza OpenCode. Solo envía el escenario y los ficheros sintéticos de la prueba. Usa una configuración temporal y desactiva el indexador.

```powershell
$env:ROUTER_EVAL_CLI = 'C:\ruta\a\opencode.exe'
$env:ROUTER_EVAL_MODEL = '<referencia-de-prueba>'
node --test eval/live-discovery.mjs
```

Exige cero búsquedas para una respuesta que no necesita herramientas, una sola para la primera lectura y cero para la segunda, ya disponible en la misma sesión. Las peticiones en portugués cubren la lectura de un log, la consulta de una skill y ambas operaciones en una sola búsqueda sin `kind`. El catálogo ficticio tiene tres skills de logs parecidas. Los escenarios con skills exigen cargar únicamente la de diagnóstico y devolver el resultado exacto. También se comprueban la consulta traducida, las restricciones estructuradas y la ruta exacta. Es una prueba de comportamiento para estos escenarios, no una garantía para otras tareas o modelos.

## OpenCode real en Docker

Desde la raíz del repositorio (PowerShell):

```powershell
docker build -t capability-router-compaction-eval ./eval
docker run --rm --network none --mount "type=bind,source=$PWD,target=/router,readonly" capability-router-compaction-eval
```

En WSL, ejecuta los mismos comandos desde la ruta del repositorio accesible desde Linux (`$PWD` debe ser una ruta de WSL). Para construir sin red si ya está disponible la imagen de QA local, añade `--network none --build-arg OPENCODE_IMAGE=router-mcp-qa:isolated` a `docker build`.

El contenedor prueba el código montado en `/router` con OpenCode 2.3.2 por defecto y un proveedor local determinista, sin modelos externos ni credenciales reales. Para probar otra versión, añade, por ejemplo, `--build-arg OPENCODE_IMAGE=ghcr.io/anomalyco/opencode:2.4.2` a `docker build`. El proveedor simula el consumo de tokens; OpenCode realiza las compactaciones y lee el fichero de prueba. El escenario exige al menos 9 compactaciones automáticas, 37 lecturas completadas (una tras un nuevo mensaje), una sola llamada a `find_capabilities` y ningún error de ejecución de herramientas.

## Modelo explícito para el indexador

Desde la raíz del repositorio, con la misma imagen:

```powershell
node --test tests/indexer-model.test.mjs
docker run --rm --network none --mount "type=bind,source=$PWD,target=/router,readonly" capability-router-compaction-eval /eval/indexer-model.mjs
docker run --rm --network none --mount "type=bind,source=$PWD,target=/router,readonly" capability-router-compaction-eval /eval/indexer-model.mjs installed
```

La prueba en Docker configura `agents.indexer.model` con un modelo distinto al de la sesión principal. Usa un endpoint local determinista; verifica el modelo y el destino reales de la petición de indexación, una sesión raíz separada y sin herramientas, y la persistencia de conceptos. El test local cubre también la precedencia del override, el rechazo de cambios de proveedor no autorizados y el caso en que cambiar solo el modelo no dispara una reindexación.

El modo `installed` ejecuta el instalador en un perfil temporal sin indexador configurado. Al abrir OpenCode, un turno del agente predeterminado debe conservar sus herramientas y activar una indexación aislada que hereda la configuración de la sesión.
