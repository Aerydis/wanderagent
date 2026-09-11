import "dotenv/config";
import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("docs"));

app.get("/api/health", (request, response) => {
  response.json({
    status: "ok",
    message: "The Wander backend is running."
  });
});

app.get("/api/directline/token", async (request, response) => {
  try {
    // Must be the published parent Wander agent's Direct Line secret,
    // not the API child agent (cr9fa_api).
    const secret = process.env.DIRECT_LINE_SECRET;

    if (!secret) {
      return response.status(500).json({
        error: "DIRECT_LINE_SECRET is missing from the .env file. Use the parent Wander agent web-channel secret."
      });
    }

    const tokenResponse = await fetch(
      "https://directline.botframework.com/v3/directline/tokens/generate",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json"
        }
      }
    );

    const responseText = await tokenResponse.text();

    if (!tokenResponse.ok) {
      console.error(
        "Direct Line token error:",
        tokenResponse.status,
        responseText
      );

      return response.status(tokenResponse.status).json({
        error: "Direct Line rejected the token request.",
        directLineStatus: tokenResponse.status,
        details: responseText
      });
    }

    let tokenData;

    try {
      tokenData = JSON.parse(responseText);
    } catch {
      return response.status(502).json({
        error: "Direct Line returned an invalid JSON response."
      });
    }

    if (!tokenData.token) {
      return response.status(502).json({
        error: "Direct Line did not return a token."
      });
    }

    return response.json({
      token: tokenData.token,
      conversationId: tokenData.conversationId || null,
      expiresIn: tokenData.expires_in || null
    });
  } catch (error) {
    console.error("Token endpoint failure:", error);

    return response.status(500).json({
      error: "The backend could not request a Direct Line token."
    });
  }
});

app.get("/api/explanation/token", async (request, response) => {
  try {
    const secret = process.env.EXPLANATION_DIRECT_LINE_SECRET;

    if (!secret) {
      return response.status(500).json({
        error: "EXPLANATION_DIRECT_LINE_SECRET is missing from the .env file."
      });
    }

    const tokenResponse = await fetch(
      "https://directline.botframework.com/v3/directline/tokens/generate",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json"
        }
      }
    );

    const responseText = await tokenResponse.text();
    let tokenData;

    try {
      tokenData = JSON.parse(responseText);
    } catch {
      return response.status(502).json({
        error: "Direct Line returned an invalid explanation token response."
      });
    }

    if (!tokenResponse.ok || !tokenData.token) {
      return response.status(tokenResponse.ok ? 502 : tokenResponse.status).json({
        error: "Direct Line rejected the explanation agent token request."
      });
    }

    return response.json({
      token: tokenData.token,
      conversationId: tokenData.conversationId || null,
      expiresIn: tokenData.expires_in || null
    });
  } catch (error) {
    console.error("Explanation token endpoint failure:", error);

    return response.status(500).json({
      error: "The backend could not request an explanation agent token."
    });
  }
});

app.listen(port, () => {
  console.log(`Wander is running at http://localhost:${port}`);
  console.log(
    `Health check: http://localhost:${port}/api/health`
  );
});