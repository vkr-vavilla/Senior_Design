import asyncio
import websockets
import json


TOKEN = input("Paste your JWT token: ").strip()
URI = f"ws://localhost:8000/chat/ws?token={TOKEN}"


async def chat():
    async with websockets.connect(URI) as ws:
        print("Connected! Type your messages (Ctrl+C to quit)\n")
        while True:
            message = input("You: ").strip()
            if not message:
                continue
            await ws.send(json.dumps({"message": message}))
            print("Gemini: ", end="", flush=True)
            while True:
                response = json.loads(await ws.recv())
                if response["done"]:
                    print()
                    break
                print(response["chunk"], end="", flush=True)


asyncio.run(chat())
