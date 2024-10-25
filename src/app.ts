import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"
import { OpenAI } from 'openai';
import axios from 'axios';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express'
import fs from 'fs';
import cors from 'cors';

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
const userQueues = new Map();
const userLocks = new Map();
const SECRET_KEY = process.env.NODE_SECRET_KEY; // Clave secreta compartida con Laravel
const API_BACKEND = process.env.API_BACKEND ?? ''; // URL base del backend Laravel


const identifiers: { [key: string]: string } = {};
const pendingIdentifiers: { [key: string]: Promise<string> } = {};
interface MediaImagen {
    id: number; // o el tipo que corresponda
    url: string; // Asegúrate de que esta propiedad exista
}

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
});

const getOrCreateIdentifier = async (key: string): Promise<string> => {
    // Verificar si el identificador ya existe
    if (Object.prototype.hasOwnProperty.call(identifiers, key)) {
        return identifiers[key];
    }

    // Si hay una solicitud en curso para el mismo identificador, espera su resultado
    if (Object.prototype.hasOwnProperty.call(pendingIdentifiers, key)) {
        return pendingIdentifiers[key];
    }

    try {
        // Crear una promesa pendiente para evitar duplicados
        pendingIdentifiers[key] = (async () => {
            const thread = await openai.beta.threads.create();
            identifiers[key] = thread.id; // Asignar el identificador creado
            return identifiers[key];
        })();

        // Esperamos a que la promesa se resuelva y luego la eliminamos de las pendientes
        const result = await pendingIdentifiers[key];
        delete pendingIdentifiers[key]; // Limpieza
        return result;
    } catch (error) {
        console.error(`Error creando identificador para clave: ${key}`, error);
        delete pendingIdentifiers[key]; // Asegurar limpieza en caso de error
        throw error; // Re-lanzamos el error para que se maneje aguas arriba
    }
};

async function sendRequest(endpoint, data) {
    const timestamp = Date.now().toString(); // Timestamp para evitar ataques de repetición
    const payload = JSON.stringify(data); // Convertimos los datos a JSON
  
    // Creamos el mensaje para la firma HMAC
    const message = `${timestamp}.${payload}`;
    const signature = SECRET_KEY;// generateHMAC(message, SECRET_KEY);
  
    try {
      const response = await axios.post(
        `${API_BACKEND}${endpoint}`,
        data,
        {
          headers: {
            'X-Timestamp': timestamp,
            'X-Signature': signature, // Adjuntamos la firma HMAC
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error(`Error en la solicitud a ${endpoint}:`, error.response?.data || error.message);
      throw error;
    }
  }


  /** Iniciar Servidor Express */
const app = express();
const router = express.Router();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

/**
 * Endpoint para servir una imagen QR.
 */
router.get('/qr', (req, res) => {
    const imagePath = path.resolve('bot.qr.png'); 
    try {
        const imagePath = path.resolve('bot.qr.png');
        const imageBuffer = fs.readFileSync(imagePath);

        // Convertir la imagen a Base64
        const base64Image = imageBuffer.toString('base64');

        // Preparar la respuesta en formato JSON con Data URL
        const mimeType = 'image/png';
        res.json({
            qr: `data:${mimeType};base64,${base64Image}`
        });

    } catch (error) {
        console.error('Error sirviendo la imagen QR:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Montar las rutas del router en el servidor Express
app.use(router);

// // Iniciar el servidor Express
app.listen(1131, () => {
    console.log(`Servidor escuchando en http://localhost:1131`);
});

const functions = {
    get_last_event: async function(data) {
        console.log(data['typeEvents'])
        if(data['typeEvents'] != null){
            return await sendRequest('/test1', { equipo: data['teamName'], typeEvents: data['typeEvents'] });
        }else{
            return await sendRequest('/test1', { equipo: data['teamName'] });
        }
    },
    get_events_by_date: async function (data) {
        const { start_date, end_date, teamName, typeEvents } = data;
        console.log(`Fetching events from ${start_date} to ${end_date} for team ${teamName || 'any'}`);

        const payload = { 
            start_date, 
            end_date ,
            equipo: data['teamName']
        };

        // if (teamName) {
        //     payload.equipo = teamName;
        // }

        // if (typeEvents && typeEvents.length > 0) {
        //     payload.typeEvents = typeEvents;
        // }

        return await sendRequest('/test2', payload); // Cambiar endpoint según sea necesario
    }
    // Puedes definir más funciones aquí si es necesario
};

const endRunIfActive = async (threadId) => {
    // Verifica si hay un 'run' activo
    const activeRuns = await openai.beta.threads.runs.list(threadId);
    const activeRun = activeRuns.data.find(run => run.status !== "completed");
  
    if (activeRun) {
      console.log(`Finalizando run activo: ${activeRun.id}`);
      // Espera a que el run se complete o cancélalo si es necesario
      await openai.beta.threads.runs.cancel(threadId, activeRun.id);
    }
  };

const sendMessageAssistant = async(ctx,flowDynamic) => {
    try {
    // buscamos hilo.
    const thread = await getOrCreateIdentifier(ctx.from)
    
      const userMessage = ctx.body;
      
      // Create a Thread
      //const threadResponse = await openai.beta.threads.create();
      const threadId = thread;
      console.log("A");
      // Add a Message to a Thread
      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: userMessage,
      });
      console.log("B");
      // Run the Assistant
      const runResponse = await openai.beta.threads.runs.create(threadId, {
        assistant_id: ASSISTANT_ID,
      });
      console.log(2)
      // Check the Run status
      let run = await openai.beta.threads.runs.retrieve(threadId, runResponse.id);
      console.log(3)
      while (run.status !== "completed") {
        
        await new Promise((resolve) => setTimeout(resolve, 10000));
        run = await openai.beta.threads.runs.retrieve(threadId, runResponse.id);
        // llamando a 
        console.log({status:run.status})
        console.log({a1:run.required_action})
        let call_function=true;
        if (run.required_action !== undefined && run.required_action !== null && call_function) {
            console.log({ reun: run.required_action.submit_tool_outputs.tool_calls });
            console.log({ reun: run.required_action.submit_tool_outputs.tool_calls[0].function });
            
            const obj = run.required_action.submit_tool_outputs.tool_calls[0].function;
            
            // Obtener el nombre de la función
            const nameFunction = obj.name;
            
            // Analizar el argumento JSON
            const args = JSON.parse(obj.arguments);
           
        
            
            // Llamar a la función usando el nombre almacenado y los parámetros
            if (typeof functions[nameFunction] === 'function') {

                if(nameFunction=='get_last_event'){
                    // Obtener los parámetros del equipo y el tipo de evento (opcional)
                    const teamName = args.team.name;
                    const typeEvents = args.type_events; // Por defecto un array vacío si no se proporciona
                
                    // Imprimir los resultados
                    console.log('Nombre de la función:', nameFunction);
                    console.log('Equipo:', teamName);
                    console.log('Tipos de eventos:', typeEvents);
                    const response = await functions[nameFunction]({teamName, typeEvents});
                    const api_r = response;
                    console.log({ api_r: response });
                    call_function = false;
            
                    // Redactar el texto de la respuesta
                    const txt_call_function = 
                        `Equipo: ${api_r['equipo']}, Tipo de evento: ${api_r['tipo_evento']}, fecha: ${api_r['date']}, descripción: ${api_r['description']}`;
            
                    // Procesar las imágenes recibidas
                    const mediaImagenes = api_r['media_imagenes'] || [];
            
                    // Mapeamos cada imagen para crear el formato requerido
                    const flowItems = mediaImagenes.map(imagen => ({
                        body: '', // Agregar un cuerpo si es necesario
                        media: imagen.url // Asegúrate de que 'url' sea la propiedad correcta
                    }));
            
                    // Enviar cada imagen individualmente usando flowDynamic
                    console.log({ flowItems });
            
                    for (let index = 0; index < flowItems.length; index++) {
                        await flowDynamic([{ body: 'imagen '+(index+1), media: flowItems[index]['media'] }]);
                    }
            
                    // Enviar la respuesta final del evento
                    // await flowDynamic([{ body: txt_call_function }]);
            
                    // Marcar el run como completado
                    run.status = "completed";
            
                    // Finalizar el run activo si existe
                    await endRunIfActive(threadId);
            
                    // Retornar el texto de la función para su uso posterior si es necesario
                    return txt_call_function;
                }
                else if(nameFunction=='get_events_by_date'){
                    const teamName = args.team.name ?? null;
                    const start_date = args.date_range.start_date;
                    const end_date = args.date_range.end_date;
                    const typeEvents = args.type_events;

                    console.log('Nombre de la función:', nameFunction);
                    console.log('Equipo:', teamName);
                    console.log('Tipos de eventos:', typeEvents);
                    console.log('start_date:', start_date);
                    console.log('end_date:', end_date);
                    const response = await functions[nameFunction]({teamName, typeEvents,start_date,end_date});
                    const api_r = response;
                    console.log({ api_r: response });
                    call_function = false;
            
                    // Construir el mensaje para cada día con sus eventos
                    let txt_call_function = '';

                    // Iterar sobre los resultados agrupados por fecha
                    api_r.forEach((entry) => {
                        const { date, events } = entry;
                        txt_call_function += `Fecha: ${date}\n`;

                        events.forEach((event, index) => {
                            txt_call_function += 
                                `  ${index + 1}. Equipo: ${event.equipo}, Tipo de evento: ${event.tipo_evento}, ` +
                                `Descripción: ${event.description || 'Sin descripción'}\n`;
                        });

                        txt_call_function += '\n'; // Espacio entre fechas
                    });

                    console.log('Mensaje final:', txt_call_function);
            
                    // Enviar la respuesta final del evento
                    // await flowDynamic([{ body: txt_call_function }]);
            
                    // Marcar el run como completado
                    run.status = "completed";
            
                    // Finalizar el run activo si existe
                    await endRunIfActive(threadId);
            
                    // Retornar el texto de la función para su uso posterior si es necesario
                    return txt_call_function;
                }
                 // Pasa ambos parámetros
                
            } else {
                console.log(`La función ${nameFunction} no está definida.`);
            }
        }
        
    
        
      }
      console.log(3)
      // Display the Assistant's Response
      const messagesResponse = await openai.beta.threads.messages.list(threadId);
      console.log({messagesResponse})
      const assistantResponses = messagesResponse.data.filter(msg => msg.role === 'assistant');
      console.log({assistantResponses})
  
      const response = assistantResponses.map(msg => 
        msg.content
          .filter(contentItem => contentItem.type === 'text')
          .map(textContent => textContent.text.value)
          .join('\n')
      ).join('\n');
      
      console.log({response});
      //await flowDynamic([{body:'😜', media: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSdI5h6LZxis-xvMA-mioIFBUdBqrofceIn1A&s"}])
      return response;
  
    } catch (error) {
      console.error("Error processing chat:", error);
    }
  }

/**
 * Function to process the user's message by sending it to the OpenAI API
 * and sending the response back to the user.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    console.log('processUserMessage- f');
    await typing(ctx, provider);
    console.log({ctx})

    console.log('vamos')
  
    const response = await sendMessageAssistant(ctx, flowDynamic);

    console.log('vamos 2')

    console.log({response})
    // Split the response into chunks and send them sequentially
    const chunks = response.split(/\n\n+/);
    console.log({chunks})
    for (const chunk of chunks) {
         console.log({chunk})
         const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
         console.log({cleanedChunk})
         await flowDynamic([{ body: cleanedChunk }]);
    }
    console.log('processUserMessage-en f');
};

/**
 * Function to handle the queue for each user.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    
    if (userLocks.get(userId)) {
        return; // If locked, skip processing
    }

    while (queue.length > 0) {
        userLocks.set(userId, true); // Lock the queue
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            console.log('processUserMessage');
            await processUserMessage(ctx, { flowDynamic, state, provider });
            console.log('processUserMessage-end');
        } catch (error) {
            console.error(`Error processing message for user ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); // Release the lock
        }
    }

    userLocks.delete(userId); // Remove the lock once all messages are processed
    userQueues.delete(userId); // Remove the queue once all messages are processed
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 * @type {import('@builderbot/bot').Flow<BaileysProvider, MemoryDB>}
 */
const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from; // Use the user's ID to create a unique queue for each user

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        // If this is the only message in the queue, process it immediately
        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }
    });

/**
 * Función principal que configura y inicia el bot
 * @async
 * @returns {Promise<void>}
 */
const main = async () => {

    /**
     * Flujo del bot
     * @type {import('@builderbot/bot').Flow<BaileysProvider, MemoryDB>}
     */
    const adapterFlow = createFlow([welcomeFlow]);

    /**
     * Proveedor de servicios de mensajería
     * @type {BaileysProvider}
     */
    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
    });

    /**
     * Base de datos en memoria para el bot
     * @type {MemoryDB}
     */
    const adapterDB = new MemoryDB();

    /**
     * Configuración y creación del bot
     * @type {import('@builderbot/bot').Bot<BaileysProvider, MemoryDB>}
     */
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);
    httpServer(+PORT);
};

main();
