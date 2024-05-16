import {DisconnectReason} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import {criarTexto, consoleErro, corTexto, verificarEnv, criarArquivosNecessarios, verificarNumeroDono, versaoAtual} from'../lib/util.js'
import {obterMensagensTexto} from '../lib/msgs.js' 
import fs from "fs-extra"
import * as socket from './socket.js'
import {converterMensagem, tiposPermitidosMensagens}  from './mensagem.js'
import {checagemMensagem} from '../lib/checagemMensagem.js'
import {chamadaComando} from '../lib/chamadaComando.js'
import {BotControle} from '../controles/BotControle.js'
import {GrupoControle} from '../controles/GrupoControle.js'
import {MensagemControle} from '../controles/MensagemControle.js'
import dotenv from 'dotenv'


export const conexaoEncerrada = async(conexao)=>{
    const botInfoJSON = await new BotControle().obterInformacoesBot()
    const msgs_texto = obterMensagensTexto(botInfoJSON)
    const { lastDisconnect } = conexao
    let reconectar = false
    const erroCodigo = (new Boom(lastDisconnect.error))?.output?.statusCode
    if(lastDisconnect.error.message == "Comando"){
        consoleErro(msgs_texto.geral.desconectado.comando, "DESCONECTADO")
    } else if( lastDisconnect.error.message == "erro_geral"){
        consoleErro(msgs_texto.geral.desconectado.falha_grave, "DESCONECTADO")
    } else {
        if(erroCodigo == DisconnectReason?.loggedOut){
            fs.rmSync("./auth_info_baileys", {recursive: true, force: true})
            consoleErro(msgs_texto.geral.desconectado.deslogado, "DESCONECTADO")
        } else if(erroCodigo == DisconnectReason?.restartRequired){
            consoleErro(msgs_texto.geral.desconectado.reiniciar, "DESCONECTADO")
        } else {
            consoleErro(criarTexto(msgs_texto.geral.desconectado.conexao, erroCodigo, lastDisconnect.error.message), "DESCONECTADO")
        }
        reconectar = true
    }
    return reconectar
}

export const conexaoAberta = async(c)=>{
    try{
        const bot = new BotControle()
        const botInfoJSON = await bot.obterInformacoesBot()
        const msgs_texto = obterMensagensTexto(botInfoJSON)
        console.log(criarTexto(msgs_texto.inicio.inicializando, versaoAtual()))
        await criarArquivosNecessarios()
        dotenv.config()
        await socket.obterTodosGrupos(c)
        await bot.inicializarBot(c)
        await verificarEnv()
        await verificarNumeroDono()
    } catch(err){
        consoleErro(err, "Inicialização")
        c.end(new Error("erro_geral"))
    }
}

export const receberMensagem = async (c, mensagem)=>{
    try{
        if(mensagem.messages[0].key.fromMe) await new MensagemControle().armazenarMensagem(mensagem.messages[0])
        switch (mensagem.type) {
            case "notify":
                if(mensagem.messages[0].message == undefined) return
                const grupos = new GrupoControle()
                const botInfoJSON = await new BotControle().obterInformacoesBot()
                const mensagemBaileys = await converterMensagem(mensagem)
                if(!tiposPermitidosMensagens.includes(mensagemBaileys.type)) return
                if(!await grupos.filtroAntiLink(c, mensagemBaileys, botInfoJSON)) return
                if(!await grupos.filtroAntiFlood(c, mensagemBaileys, botInfoJSON)) return
                if(!await checagemMensagem(c, mensagemBaileys, botInfoJSON)) return
                await chamadaComando(c, mensagemBaileys, botInfoJSON)
                break
            case "append":
                break
        }
    } catch(err){
        consoleErro(err, "MESSAGES.UPSERT")
        c.end(new Error("erro_geral"))
    }
}

export const adicionadoEmGrupo = async (c, dadosGrupo)=>{
    try{
        const botInfoJSON = await new BotControle().obterInformacoesBot()
        const msgs_texto = obterMensagensTexto(botInfoJSON)
        await new GrupoControle().registrarGrupoAoSerAdicionado(dadosGrupo[0])
        await socket.enviarTexto(c, dadosGrupo[0].id, criarTexto(msgs_texto.geral.entrada_grupo, dadosGrupo[0].subject)).catch(()=>{})
    } catch(err){
        consoleErro(err, "GROUPS.UPSERT")
    }
}

export const atualizacaoParticipantesGrupo = async (c, evento)=>{
    try{
        const grupos = new GrupoControle()
        const isBotUpdate = evento.participants[0] == await new BotControle().obterNumeroBot()
        const g_info = await grupos.obterGrupoInfo(evento.id)
        if (evento.action == 'add') {
            //SE O PARTICIPANTE ESTIVER NA LISTA NEGRA, EXPULSE
            if(!await grupos.verificarListaNegraUsuario(c,evento)) return
            //ANTIFAKE
            if(!await grupos.filtroAntiFake(c,evento,g_info)) return
            //BEM-VINDO
            await grupos.mensagemBemVindo(c,evento,g_info)
            //CONTADOR
            if(g_info?.contador.status) await grupos.verificarRegistrarContagemParticipante(evento.id, evento.participants[0])
            await grupos.adicionarParticipante(evento.id, evento.participants[0])
        } else if(evento.action == "remove"){
            if(isBotUpdate){
                if(g_info?.contador.status) await grupos.removerContagemGrupo(evento.id)
                await grupos.removerGrupo(evento.id)
            } else{
                await grupos.removerParticipante(evento.id, evento.participants[0])
            }
        } else if(evento.action == "promote"){
            await grupos.adicionarAdmin(evento.id, evento.participants[0])
        } else if(evento.action == "demote"){
            await grupos.removerAdmin(evento.id, evento.participants[0])
        }
    } catch(err){
        consoleErro(err, "GROUP-PARTICIPANTS.UPDATE")
        c.end(new Error("erro_geral"))
    }
}

export const atualizacaoDadosGrupos = async (c, novosDadosGrupo)=>{
    try{
        const grupos = new GrupoControle()
        //Cadastro de grupos
        await grupos.registrarGruposAoIniciar(novosDadosGrupo)
        //Atualização dos participantes dos grupos
        await grupos.atualizarDadosGruposInicio(novosDadosGrupo)
        //Verificar lista negra dos grupos
        await grupos.verificarListaNegraGeral(c, novosDadosGrupo)
        //Atualização da contagem de mensagens
        await grupos.atualizarContagemGrupos(novosDadosGrupo)

        const botInfoJSON = await new BotControle().obterInformacoesBot()
        // Log : Grupos carregados e atualizados
        console.log('[GRUPOS]', corTexto(obterMensagensTexto(botInfoJSON).inicio.grupos_carregados))
        // Log : Servidor iniciado
        console.log('[SERVIDOR]', corTexto(obterMensagensTexto(botInfoJSON).inicio.servidor_iniciado))
        return true
    } catch(err){
        consoleErro(err, "GROUPS.UPDATE")
    }
}

export const realizarEventosEspera = async(c, eventosEsperando)=>{
    for(let ev of eventosEsperando) c.ev.emit(ev.evento, ev.dados)
}

export const atualizacaoDadosGrupo = async (dadosGrupo)=>{
    try{
        await new GrupoControle().atualizarDadosGrupoParcial(dadosGrupo)
    } catch(err){
        consoleErro(err, "GROUPS.UPDATE")
    }
}

