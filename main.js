async function translate(text, from, to, options) {
    const { config, utils, setResult } = options;
    const { tauriFetch } = utils;
    
    // 获取用户在 Pot 界面中的配置项
    let { 
        apiKey, 
        model = "deepseek-v4-pro", 
        thinking = "true", 
        reasoning_effort = "high", 
        show_thinking = "false",
        stream = "true" 
    } = config;
    
    const requestPath = "https://api.deepseek.com/chat/completions";
    
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
    };
    
    // 布尔值转换解析
    const isStream = stream === "true";
    const isThinking = thinking === "true";
    const isShowThinking = show_thinking === "true";
    
    const body = {
        model: model, 
        messages:[
            {
                "role": "system",
                "content": "You are a professional translation engine, please translate the text into a colloquial, professional, elegant and fluent content, without the style of machine translation. You must only translate the text content, never interpret it."
            },
            {
                "role": "user",
                "content": `Translate into ${to}:\n${text}`
            }
        ],
        stream: isStream,
        temperature: 1,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        max_tokens: 60000
    };
    
    // 配置 V4 API 思考模式参数
    if (isThinking) {
        body.thinking = { type: "enabled" };
        body.reasoning_effort = reasoning_effort;
    } else {
        body.thinking = { type: "disabled" };
    }

    // 处理【流式请求】逻辑
    if (isStream) {
        // 【关键修复】：利用 Controller 设置 999 秒的超长超时，防止后台长思考导致的断连
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 999 * 1000);

        try {
            const res = await globalThis.fetch(requestPath, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: controller.signal,
                timeout: 999 // 显式兼容部分拦截器参数
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Http Status: ${res.status}\n${errText}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let targetText = "";
            let reasoningText = "";
            let finalOutputText = ""; 
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let lines = buffer.split('\n');
                buffer = lines.pop(); 

                for (let line of lines) {
                    line = line.trim();
                    if (!line || line === 'data: [DONE]') continue;
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.substring(6));
                            if (data.choices && data.choices[0].delta) {
                                const delta = data.choices[0].delta;
                                
                                // 分别收集思考内容和翻译内容
                                if (delta.reasoning_content) {
                                    reasoningText += delta.reasoning_content;
                                }
                                if (delta.content) {
                                    targetText += delta.content;
                                }
                                
                                // 动态构建前端显示的文本
                                finalOutputText = "";
                                if (isShowThinking && reasoningText) {
                                    finalOutputText += `🤔 思考过程：\n${reasoningText}\n\n`;
                                    if (targetText) {
                                        finalOutputText += `🎯 翻译结果：\n`;
                                    }
                                }
                                finalOutputText += targetText;
                                
                                // 实时更新至 Pot 终端页面
                                if (finalOutputText) {
                                    setResult(finalOutputText); 
                                }
                            }
                        } catch (e) {
                            // 忽略不完整流的单次 Parse 错误
                        }
                    }
                }
            }
            // 结束时务必清除计时器
            clearTimeout(timeoutId);
            return finalOutputText;
        } catch (error) {
            clearTimeout(timeoutId);
            // 静默拦截异常，优雅降级为非流式处理
            body.stream = false;
        }
    }

    // 处理【非流式请求】逻辑 (以及流式请求降级 fallback)
    let res = await tauriFetch(requestPath, {
        method: 'POST',
        url: requestPath,
        headers: headers,
        timeout: 999, // 【关键修复】：确保原生的 Tauri 请求也配置 999s 的超时容忍
        body: {
            type: "Json",
            payload: body
        }
    });
    
    if (res.ok) {
        let result = res.data;
        if (result.choices && result.choices.length > 0) {
            const message = result.choices[0].message;
            let finalOutput = "";
            
            // 非流式下，开启显示思考则拼接排版
            if (isShowThinking && message.reasoning_content) {
                finalOutput += `🤔 思考过程：\n${message.reasoning_content}\n\n🎯 翻译结果：\n`;
            }
            // 拼接纯译文
            finalOutput += (message.content || "").trim().replace(/^"|"$/g, '');
            
            return finalOutput;
        } else {
            throw "接口响应为空或格式异常。";
        }
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}