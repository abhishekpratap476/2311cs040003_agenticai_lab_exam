import os
import re
import json
import logging
import threading
from datetime import datetime
from flask import Flask, render_template, request, Response, jsonify
from flask_cors import CORS
import ollama

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

MODEL_NAME = "llama3.2"
CHATS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chats")
os.makedirs(CHATS_DIR, exist_ok=True)

file_locks = {}
locks_lock = threading.Lock()

def get_file_lock(filename):
    """Returns a re-entrant lock specific to a filename."""
    with locks_lock:
        if filename not in file_locks:
            file_locks[filename] = threading.Lock()
        return file_locks[filename]

def sanitize_filename(prompt):
    """
    Sanitizes user prompt to create a safe, readable filename on Windows/Linux.
    Example: 'What is Python programming?' -> 'What_is_Python_programming.json'
    """
    cleaned = re.sub(r'[\\/*?:"<>|\r\n\t]', '', prompt).strip()
    cleaned = re.sub(r'\s+', '_', cleaned)
    # Truncate to avoid overly long filenames
    cleaned = cleaned[:45] if cleaned else "Chat"
    
    filename = f"{cleaned}.json"
    full_path = os.path.join(CHATS_DIR, filename)
    
    # If a file with this name already exists, add a numeric suffix
    counter = 1
    base_name = cleaned
    while os.path.exists(full_path):
        filename = f"{base_name}_{counter}.json"
        full_path = os.path.join(CHATS_DIR, filename)
        counter += 1
        
    return filename

def load_chat_file(filename):
    """Loads a specific chat file."""
    filepath = os.path.join(CHATS_DIR, filename)
    lock = get_file_lock(filename)
    with lock:
        if not os.path.exists(filepath):
            return None
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error reading {filepath}: {e}")
            return None

def save_chat_file(filename, data):
    """Saves data to a specific chat file."""
    filepath = os.path.join(CHATS_DIR, filename)
    lock = get_file_lock(filename)
    with lock:
        data["updated_at"] = datetime.now().isoformat()
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Error writing {filepath}: {e}")

@app.route("/")
def index():
    """Renders the main chat studio."""
    return render_template("index.html")

@app.route("/api/status", methods=["GET"])
def get_status():
    """Checks the status of the Ollama service and active model."""
    try:
        models_response = ollama.list()
        model_list = []
        if isinstance(models_response, dict) and "models" in models_response:
            model_list = [m.get("name") or m.get("model") for m in models_response["models"]]
        elif hasattr(models_response, "models"):
            model_list = [getattr(m, "model", getattr(m, "name", str(m))) for m in models_response.models]

        is_model_present = any(MODEL_NAME in m for m in model_list)
        return jsonify({
            "status": "online",
            "active_model": MODEL_NAME,
            "model_ready": is_model_present,
            "models": model_list
        })
    except Exception as e:
        logger.exception("Error checking Ollama status")
        return jsonify({
            "status": "offline",
            "error": str(e),
            "active_model": MODEL_NAME,
            "model_ready": False,
            "models": []
        }), 503

@app.route("/api/chats", methods=["GET"])
def list_chats():
    """Lists all saved chat JSON files from the chats/ directory."""
    chats = []
    if os.path.exists(CHATS_DIR):
        for f in os.listdir(CHATS_DIR):
            if f.endswith(".json"):
                filepath = os.path.join(CHATS_DIR, f)
                try:
                    with open(filepath, "r", encoding="utf-8") as fp:
                        data = json.load(fp)
                        chats.append({
                            "filename": f,
                            "title": data.get("title", f.replace(".json", "").replace("_", " ")),
                            "created_at": data.get("created_at"),
                            "updated_at": data.get("updated_at"),
                            "message_count": len(data.get("messages", [])),
                            "persona": data.get("persona", "Default")
                        })
                except Exception as e:
                    logger.warning(f"Could not read {f}: {e}")
                    chats.append({
                        "filename": f,
                        "title": f.replace(".json", "").replace("_", " "),
                        "created_at": None,
                        "updated_at": None,
                        "message_count": 0,
                        "persona": "Default"
                    })

    # Sort newest updated first
    chats.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return jsonify({"chats": chats})

@app.route("/api/chats/<path:filename>", methods=["GET"])
def get_chat(filename):
    """Loads a specific chat file."""
    data = load_chat_file(filename)
    if data is None:
        return jsonify({"error": "Chat file not found"}), 404
    return jsonify(data)

@app.route("/api/chats/<path:filename>", methods=["DELETE"])
def delete_chat(filename):
    """Deletes a specific chat JSON file."""
    filepath = os.path.join(CHATS_DIR, filename)
    if os.path.exists(filepath):
        try:
            os.remove(filepath)
            return jsonify({"success": True, "filename": filename})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "File not found"}), 404

@app.route("/api/chats", methods=["DELETE"])
def clear_all_chats():
    """Deletes all chat JSON files in chats/."""
    if os.path.exists(CHATS_DIR):
        for f in os.listdir(CHATS_DIR):
            if f.endswith(".json"):
                try:
                    os.remove(os.path.join(CHATS_DIR, f))
                except Exception as e:
                    logger.warning(f"Failed to remove {f}: {e}")
    return jsonify({"success": True, "message": "All chat files deleted"})

@app.route("/api/chat", methods=["POST"])
def chat():
    """
    Handles streaming chat with Ollama.
    If 'filename' is provided, appends to that existing JSON file.
    If 'filename' is empty/None, creates a NEW JSON file named after the first user prompt.
    """
    data = request.get_json() or {}
    messages = data.get("messages", [])
    stream = data.get("stream", True)
    model = data.get("model", MODEL_NAME)
    persona = data.get("persona", "Default")
    filename = data.get("filename")

    if not messages:
        return jsonify({"error": "No messages provided"}), 400

    # Find the current user message
    last_user_msg = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            last_user_msg = msg.get("content", "")
            break

    # Determine or create the JSON file
    is_new_chat = False
    if not filename or not os.path.exists(os.path.join(CHATS_DIR, filename)):
        # Generate new filename from the first user prompt
        filename = sanitize_filename(last_user_msg)
        is_new_chat = True
        chat_data = {
            "filename": filename,
            "title": last_user_msg.strip()[:60],
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
            "persona": persona,
            "messages": []
        }
    else:
        chat_data = load_chat_file(filename)
        if chat_data is None:
            chat_data = {
                "filename": filename,
                "title": last_user_msg.strip()[:60],
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
                "persona": persona,
                "messages": []
            }

    def generate_stream():
        assistant_chunks = []
        try:
            response_stream = ollama.chat(
                model=model,
                messages=messages,
                stream=True
            )
            for chunk in response_stream:
                content = ""
                if isinstance(chunk, dict):
                    content = chunk.get("message", {}).get("content", "")
                    done = chunk.get("done", False)
                else:
                    msg = getattr(chunk, "message", None)
                    content = getattr(msg, "content", "") if msg else ""
                    done = getattr(chunk, "done", False)

                if content:
                    assistant_chunks.append(content)

                payload = json.dumps({"content": content, "done": done, "filename": filename})
                yield f"data: {payload}\n\n"

            # When stream completes, save exchange into the specific JSON file
            full_assistant_reply = "".join(assistant_chunks)
            timestamp = datetime.now().isoformat()
            chat_data["messages"].append({
                "role": "user",
                "content": last_user_msg,
                "timestamp": timestamp
            })
            chat_data["messages"].append({
                "role": "assistant",
                "content": full_assistant_reply,
                "timestamp": timestamp
            })
            save_chat_file(filename, chat_data)

            yield f"data: {json.dumps({'done': True, 'saved': True, 'filename': filename, 'title': chat_data['title']})}\n\n"

        except Exception as e:
            logger.exception("Error during streaming chat")
            yield f"data: {json.dumps({'error': str(e), 'done': True, 'filename': filename})}\n\n"

    if stream:
        return Response(
            generate_stream(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"
            }
        )
    else:
        try:
            response = ollama.chat(
                model=model,
                messages=messages,
                stream=False
            )
            content = ""
            if isinstance(response, dict):
                content = response.get("message", {}).get("content", "")
            else:
                msg = getattr(response, "message", None)
                content = getattr(msg, "content", "") if msg else ""

            timestamp = datetime.now().isoformat()
            chat_data["messages"].append({
                "role": "user",
                "content": last_user_msg,
                "timestamp": timestamp
            })
            chat_data["messages"].append({
                "role": "assistant",
                "content": content,
                "timestamp": timestamp
            })
            save_chat_file(filename, chat_data)

            return jsonify({
                "message": {"role": "assistant", "content": content},
                "filename": filename,
                "title": chat_data["title"]
            })
        except Exception as e:
            logger.exception("Error in non-streaming chat")
            return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    print(f"Starting Llama 3.2 Studio on http://127.0.0.1:5000 (Storing chats in {CHATS_DIR})...")
    app.run(host="127.0.0.1", port=5000, debug=True)
