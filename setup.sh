#!/bin/bash
# EG-DESK External References Setup Script

echo "🚀 Setting up EG-DESK external references..."

cd "ideas&external_references" || exit 1

# Function to clone or update repository
clone_or_update() {
    local url=$1
    local dir=$2
    local name=$3

    if [ -d "$dir" ]; then
        echo "📦 Updating $name..."
        cd "$dir" && git pull --depth 1 && cd ..
    else
        echo "📥 Cloning $name (shallow)..."
        git clone --depth 1 "$url" "$dir"
    fi
}

# Clone/update external repositories (large external projects)
clone_or_update "https://github.com/eclipse-theia/theia.git" "theia" "Theia Framework"
clone_or_update "https://github.com/microsoft/playwright.git" "playwright" "Playwright Testing"
clone_or_update "https://github.com/puppeteer/puppeteer.git" "puppeteer" "Puppeteer Automation"
clone_or_update "https://github.com/google-gemini/gemini-cli.git" "gemini-cli" "Google Gemini CLI"

# Clone infinite-canvas into subfolder
if [ -d "infinite-canvas/infinite-canvas-master" ]; then
    echo "📦 Updating infinite-canvas..."
    cd "infinite-canvas/infinite-canvas-master" && git pull --depth 1 && cd ../..
else
    echo "📥 Cloning infinite-canvas (shallow)..."
    mkdir -p "infinite-canvas"
    cd "infinite-canvas"
    git clone --depth 1 "https://github.com/emilefokkema/infinite-canvas.git" "infinite-canvas-master"
    cd ..
fi

# Note: claude-agent-sdk and eg-desk ideas are project-specific resources
# already included in the repository

cd ..

echo "✅ External references setup complete!"
echo ""
echo "📂 Cloned repositories:"
echo "   - ideas&external_references/theia/ (~54MB)"
echo "   - ideas&external_references/playwright/ (~100MB)"
echo "   - ideas&external_references/puppeteer/ (~20MB)"
echo "   - ideas&external_references/gemini-cli/ (~10MB)"
echo "   - ideas&external_references/infinite-canvas/infinite-canvas-master/ (~2MB)"
echo ""
echo "💡 To update references later, run: ./setup.sh"
