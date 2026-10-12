"""Partida real no navegador: 6 celulares (contextos separados do Chromium) numa sala online.

Roda em três cenários (variável REDE):
  ambos     → caminho direto (PeerJS local) e plano B (broker MQTT local) funcionando
  sem-peer  → servidor da PeerJS fora do ar: tudo tem que passar pelo broker
  sem-mqtt  → broker fora do ar: tudo tem que passar pelo caminho direto
Tira fotos das telas (só no cenário "ambos") para conferência visual.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

SITE = os.environ.get('SITE', 'http://127.0.0.1:8080/')
REDE = os.environ.get('REDE', 'ambos')
PEER_OK = '127.0.0.1:9000'
MQTT_OK = 'ws://127.0.0.1:8883/mqtt'
DEAD_PEER = '127.0.0.1:9'
DEAD_MQTT = 'ws://127.0.0.1:9/mqtt'
QUERY = {
    'ambos': f'servidor={PEER_OK}&mqtt={MQTT_OK}',
    'sem-peer': f'servidor={DEAD_PEER}&mqtt={MQTT_OK}',
    'sem-mqtt': f'servidor={PEER_OK}&mqtt={DEAD_MQTT}',
}[REDE]
BASE = f'{SITE}?{QUERY}'
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/shots') if REDE == 'ambos' else None
if SHOTS:
    os.makedirs(SHOTS, exist_ok=True)
errors = []


def log(*a):
    print(f'[{REDE}]', *a, flush=True)


def shot(page, name):
    page.wait_for_timeout(650)  # deixa o carimbo terminar de cair
    w = page.evaluate('() => [document.documentElement.scrollWidth, window.innerWidth]')
    assert w[0] <= w[1], f'rolagem lateral em {name}: {w}'
    if SHOTS:
        page.screenshot(path=f'{SHOTS}/{name}.png', full_page=True)


def hold_and_read(page, selector='.hold'):
    btn = page.locator(selector).first
    box = btn.bounding_box()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.mouse.down()
    card = page.locator('[data-hold-show="papel"]:not([hidden]) .role-card').first
    card.wait_for(state='visible', timeout=5000)
    return card.inner_text()


def release(page):
    page.mouse.up()
    page.wait_for_timeout(100)
    assert page.locator('[data-hold-show="papel"]:not([hidden])').count() == 0, 'o papel continuou aparecendo'


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns'])

        def new_player(scheme='light'):
            ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, color_scheme=scheme)
            page = ctx.new_page()
            page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))

            def on_console(m):
                if m.type != 'error':
                    return
                t = m.text
                # Falhas de rede esperadas (o caminho que está fora do ar, nos cenários de teste)
                if any(x in t for x in ('Failed to load resource', 'WebSocket', 'ERR_', 'PeerJS', 'Lost connection', 'net::')):
                    return
                errors.append('console: ' + t)

            page.on('console', on_console)
            return page

        host = new_player()
        host.goto(BASE)
        host.wait_for_selector('text=Criar sala')
        shot(host, '01-inicio')
        host.click('text=Criar sala')
        host.fill('#nome-criar', 'Ana')
        shot(host, '02-criar')
        host.click('button[type=submit]')
        host.wait_for_selector('.code', timeout=20000)
        host.wait_for_function("() => !document.body.innerText.includes('Abrindo a sala')", timeout=30000)
        code = host.text_content('.code').strip()
        assert host.locator('.qr svg path').count() == 1, 'QR code não apareceu'
        log('sala criada:', code)

        names = ['Bia', 'Caio', 'Duda', 'Edu', 'Fê']
        clients = []
        t0 = time.time()
        for nm in names:
            pg = new_player('dark' if nm == 'Caio' else 'light')
            pg.goto(f'{BASE}&sala={code}')
            pg.wait_for_selector('#nome-entrar')
            assert pg.input_value('#codigo') == code, 'código não veio pelo link'
            pg.fill('#nome-entrar', nm)
            pg.click('button[type=submit]')
            pg.wait_for_selector('text=Esperando o anfitrião começar', timeout=30000)
            clients.append(pg)
        log('5 convidados entraram em', round(time.time() - t0, 1), 's')
        host.wait_for_selector('text=Na sala (6)', timeout=10000)
        shot(host, '03-sala-anfitriao')
        shot(clients[1], '04-sala-convidado-escuro')

        host.click('text=Começar partida')
        pages = [host] + clients
        allnames = ['Ana'] + names
        roles = {}
        for nm, pg in zip(allnames, pages):
            pg.wait_for_selector('text=Seu papel é secreto', timeout=10000)
            roles[nm] = hold_and_read(pg)
            if nm in ('Ana', 'Caio'):
                shot(pg, f'05-papel-{nm}')
            release(pg)
            pg.click('text=Já vi. Vamos jogar')
        cumplices = [nm for nm in allnames if 'sua dupla' in roles[nm].lower()]
        assert len(cumplices) == 2, roles
        a, b = cumplices
        assert b in roles[a] and a in roles[b], 'as duplas não batem'
        dets = [nm for nm in allnames if nm not in cumplices]
        log('cúmplices:', cumplices)
        P = dict(zip(allnames, pages))

        def vote_all(plan):
            for nm in allnames:
                P[nm].click(f'button.option[data-opt="{plan[nm]}"]')
            for nm in allnames:
                P[nm].wait_for_selector('.verdict .stamp', timeout=15000)

        def all_ready():
            for nm in allnames:
                P[nm].click('text=Pronto para a próxima')
            for nm in allnames:
                P[nm].wait_for_selector('button.option', timeout=15000)

        def accuse(by, x, y, answers):
            acc = P[by]
            acc.click('text=Acusar uma dupla')
            acc.click(f'button.pick:has-text("{x}")')
            acc.click(f'button.pick:has-text("{y}")')
            if SHOTS and by == dets[0]:
                shot(acc, '08-escolher-dupla')
            acc.click('button[data-a="enviar-acusacao"]')
            for nm in allnames:
                P[nm].wait_for_selector('text=Sim, acusar', timeout=15000)
            if SHOTS and by == dets[0]:
                shot(P[dets[3]], '09-votar-acusacao')
            for nm in allnames:
                P[nm].click('text=Sim, acusar' if answers(nm) else 'text=Não')

        # Pergunta 1: IGUAL (1 ponto). Ninguém pode acusar ainda.
        P[dets[0]].wait_for_selector('button.option')
        shot(P[dets[0]], '06-votacao')
        vote_all({nm: (0 if nm in cumplices else (1 + i % 2)) for i, nm in enumerate(allnames)})
        assert P[dets[0]].text_content('.verdict .stamp').strip().lower() == 'igual'
        assert P[dets[0]].locator('text=Acusar uma dupla').count() == 0
        assert P[dets[0]].locator('text=Na primeira pergunta ninguém acusa').count() == 1
        shot(P[a], '07-revelacao-igual')
        all_ready()

        # Pergunta 2: DIFERENTE; acusação errada contra dois inocentes → +1 (2 pontos)
        plan = {nm: 0 for nm in allnames}
        plan[a], plan[b] = 0, 1
        vote_all(plan)
        assert P[a].text_content('.verdict .stamp').strip().lower() == 'diferente'
        accuse(dets[0], dets[1], dets[2], lambda nm: True)
        for nm in allnames:
            P[nm].wait_for_selector('.sheet .stamp', timeout=15000)
        assert 'inocentes' in P[dets[1]].text_content('.sheet .stamp').lower()
        shot(P[dets[1]], '10-aviso-inocentes')
        for nm in allnames:
            P[nm].click('text=Continuar')
        on = host.locator('.gamebar .dots i.on').count()
        assert on == 2, f'esperava 2 pontos, veio {on}'

        # Pergunta 3: DIFERENTE de novo; detetive acusa a dupla certa
        for nm in allnames:
            P[nm].wait_for_selector('button.option', timeout=15000)
        plan = {nm: 2 for nm in allnames}
        plan[a], plan[b] = 1, 2
        vote_all(plan)
        accuse(dets[1], a, b, lambda nm: nm not in cumplices)
        for nm in allnames:
            P[nm].wait_for_selector('.pair-reveal', timeout=15000)
        end_txt = P[dets[0]].inner_text('main').lower()
        assert 'detetives venceram' in end_txt, end_txt[:300]
        assert a.lower() in P[dets[0]].inner_text('.pair-reveal').lower()
        assert 'você venceu' in end_txt
        assert 'não foi dessa vez' in P[a].inner_text('main').lower()
        shot(P[dets[0]], '11-fim-detetive')
        shot(P[a], '12-fim-cumplice')
        log('partida 1 ok')

        # Jogar de novo, depois reconexões
        host.click('text=Jogar de novo')
        for pg in pages:
            pg.wait_for_selector('text=Seu papel é secreto', timeout=10000)
            pg.click('text=Já vi. Vamos jogar')
            pg.wait_for_selector('button.option', timeout=10000)
        c = clients[2]
        c.click('button.option[data-opt="1"]')
        c.wait_for_timeout(400)
        c.reload()
        c.wait_for_selector('text=Seu papel é secreto', timeout=30000)
        c.click('text=Já vi. Vamos jogar')
        c.wait_for_selector('button.option[aria-pressed="true"][data-opt="1"]', timeout=15000)
        log('convidado recarregou e o voto continuava lá')

        host.reload()
        host.wait_for_selector('text=Voltar para a sala', timeout=10000)
        host.click('text=Voltar para a sala')
        host.wait_for_selector('text=Seu papel é secreto', timeout=30000)
        host.click('text=Já vi. Vamos jogar')
        host.wait_for_selector('button.option', timeout=10000)
        t0 = time.time()
        host.wait_for_function("() => document.querySelectorAll('.faces .av:not(.off)').length === 6", timeout=60000)
        log('todos de volta ao anfitrião em', round(time.time() - t0, 1), 's')
        for pg in pages:
            pg.click('button.option[data-opt="0"]')
        for pg in pages:
            pg.wait_for_selector('.verdict .stamp', timeout=20000)
        log('votação depois da volta do anfitrião ok')

        if SHOTS:
            g = new_player('dark')
            g.goto(BASE)
            g.click('text=Como jogar')
            g.wait_for_selector('text=Dois são cúmplices')
            shot(g, '13-como-jogar-escuro')
            g2 = new_player('light')
            g2.goto(BASE)
            g2.click('text=Como jogar')
            g2.wait_for_selector('text=Dois são cúmplices')
            shot(g2, '13-como-jogar-claro')
        browser.close()

    if errors:
        log('ERROS NO NAVEGADOR:')
        for e in errors[:20]:
            log(' -', e)
        sys.exit(1)
    log('E2E ONLINE OK')


if __name__ == '__main__':
    main()
