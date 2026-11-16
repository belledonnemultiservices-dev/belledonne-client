// Fiche dossier (Suivi, onglet En contrat) — 16/11.
// Consultation seule : « où en est ce bon, et que s'est-il passé ? ». Toute modification
// passe par la fenêtre de planification (bouton Modifier), pour n'avoir qu'un seul endroit
// qui écrit les passages, l'agenda, Kizeo et les notifications.
// Script classique : utilise les fonctions globales de suivi.html (passagesNorm, recPassage,
// notifCellule, badgesRapports, etatAgenda, marque, fileDe, LIB_ETAPE...).
(function () {
  var css = document.createElement('style');
  css.textContent = [
    '#ficheDossier{position:fixed;inset:0;z-index:1200;background:rgba(13,27,42,.45);display:none;justify-content:flex-end;}',
    '#ficheDossier.ouvert{display:flex;}',
    '.fd-panneau{background:var(--surface,#fff);width:min(980px,100%);height:100%;display:flex;flex-direction:column;box-shadow:-8px 0 30px rgba(0,0,0,.15);}',
    '.fd-tete{padding:20px 26px 14px;border-bottom:1px solid var(--border,#E3E8EE);display:flex;gap:14px;align-items:flex-start;}',
    '.fd-tete h2{margin:0;font:700 20px "DM Sans",sans-serif;color:var(--text,#0D1B2A);display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.fd-tete small{display:block;margin-top:4px;color:var(--text-mid,#4A6078);font-size:13px;}',
    '.fd-corps{flex:1;overflow:auto;padding:18px 26px 30px;}',
    '.fd-section{margin-bottom:22px;}',
    '.fd-section h3{font:700 11px "DM Sans",sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#8FA4B8;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border,#E3E8EE);}',
    '.fd-grille{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 24px;}',
    '.fd-champ label{display:block;font-size:11px;color:#8FA4B8;font-weight:600;margin-bottom:2px;}',
    '.fd-champ div{font-size:13.5px;color:var(--text,#0D1B2A);white-space:pre-wrap;word-break:break-word;}',
    '.fd-champ.large{grid-column:1/-1;}',
    '.fd-table{width:100%;border-collapse:collapse;font-size:13px;}',
    '.fd-table th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#8FA4B8;text-align:left;padding:6px 8px;border-bottom:1px solid var(--border,#E3E8EE);font-weight:700;}',
    '.fd-table td{padding:8px;border-bottom:1px solid rgba(13,27,42,.06);vertical-align:middle;}',
    '.fd-table td.c{text-align:center;} .fd-table td.c .ck-l{justify-content:center;}',
    '.fd-table tr.annule td{opacity:.5;text-decoration:line-through;}',
    '.fd-histo{list-style:none;margin:0;padding:0;}',
    '.fd-histo li{display:grid;grid-template-columns:130px 1fr;gap:12px;padding:7px 0;border-bottom:1px dashed rgba(13,27,42,.08);font-size:13px;}',
    '.fd-histo li span:first-child{color:#8FA4B8;font-variant-numeric:tabular-nums;}',
    '.fd-lien{color:#C0392B;font-weight:600;text-decoration:none;} .fd-lien:hover{text-decoration:underline;}',
    '.fd-vide{color:#8FA4B8;font-size:13px;}',
    '.fd-pied{padding:12px 26px;border-top:1px solid var(--border,#E3E8EE);display:flex;align-items:center;gap:10px;}',
    '.fd-pied .fd-discret{margin-left:auto;background:none;border:0;color:#8FA4B8;font-size:12px;text-decoration:underline;cursor:pointer;}',
    '@media (max-width:700px){.fd-grille{grid-template-columns:1fr;}.fd-histo li{grid-template-columns:1fr;gap:2px;}}'
  ].join('\n');
  document.head.appendChild(css);

  var esc = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  // Date et heure en heure locale (les horodatages sont enregistrés en UTC)
  var dh = function (iso) {
    if (!iso) return '—';
    var s = String(iso);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.substring(8, 10) + '/' + s.substring(5, 7) + '/' + s.substring(0, 4);
    var d = new Date(s); if (isNaN(d)) return esc(s);
    var p = function (n) { return String(n).padStart(2, '0'); };
    // Horodatage sans fuseau (ex. début de passage « 2026-11-16T09:00 ») : déjà en heure locale
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  var champ = function (lib, val, large) { return '<div class="fd-champ' + (large ? ' large' : '') + '"><label>' + lib + '</label><div>' + (val || '<span class="fd-vide">—</span>') + '</div></div>'; };
  var LIB_STATUT_RAPPORT = { 'en-attente': 'Attendu du technicien', 'a-relire': 'À relire', 'a-traiter': 'Prêt à envoyer', 'archive': 'Prêt à envoyer', 'envoye': 'Envoyé au client' };
  var cercle = function (n) { return (window.CERCLES && CERCLES[(n || 1) - 1]) || ('#' + n); };

  function racine() {
    var el = document.getElementById('ficheDossier');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ficheDossier';
    el.innerHTML = '<div class="fd-panneau"><div class="fd-tete"></div><div class="fd-corps"></div><div class="fd-pied"></div></div>';
    el.addEventListener('click', function (e) { if (e.target === el) fermerFicheDossier(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.classList.contains('ouvert')) fermerFicheDossier(); });
    document.body.appendChild(el);
    return el;
  }

  function sectionDossier(it) {
    var tels = Array.isArray(it.coordonnees) ? it.coordonnees : it.coordonnees ? [it.coordonnees] : [];
    var docs = [['bc', 'BC'], ['pl', 'PL'], ['devis', 'Devis']].filter(function (d) { return it[d[0]] || it[d[0] + 'Url']; })
      .map(function (d) { return d[1] + ' ' + esc(it[d[0]] || '') + (it[d[0] + 'Url'] ? ' · <a class="fd-lien" href="' + esc(it[d[0] + 'Url']) + '" target="_blank" rel="noopener">PDF</a>' : ''); }).join('<br>');
    return '<div class="fd-section"><h3>Dossier</h3><div class="fd-grille">'
      + champ('Client', esc(it.client)) + champ('Nature de la mission', esc(it.nature))
      + champ('Adresse', esc(it.adresse), true)
      + champ('Locataire / contact', esc(it.nomClient)) + champ('Téléphone(s)', esc(tels.filter(Boolean).join(' · ')))
      + champ('Email locataire', esc(it.emailClient)) + champ('Expéditeur', esc(it.expediteur))
      + champ('Date d\'émission', it.dateEmission ? dh(it.dateEmission) : '') + champ('N° Chorus', esc(it.chorus))
      + champ('Documents', docs, true)
      + champ('Observations', esc(it.observations), true)
      + (String(it.notes || '').trim() ? champ('Anciennes notes', esc(it.notes), true) : '')
      + '</div></div>';
  }

  function sectionPassages(it) {
    var ps = passagesNorm(it).filter(function (p) { return !p.jumeau; });
    if (!ps.length) return '<div class="fd-section"><h3>Passages</h3><p class="fd-vide">Aucun passage.</p></div>';
    var lignes = ps.map(function (p) {
      var annule = p.statut === 'annule';
      var cells = annule ? '<td class="c" colspan="6">passage annulé</td>' :
        '<td class="c">' + (etatAgenda(p) === 'ok' ? marque('ok', 'Dans l\'agenda') : etatAgenda(p) === 'manque' ? marque('ko', 'Pas dans l\'agenda') : marque('att', 'Agenda à mettre à jour')) + '</td>'
        + '<td class="c">' + badgesRapports(it, p, 'kizeo') + '</td>'
        + '<td class="c">' + notifCellule(it, p, 'notifBailleur') + '</td>'
        + '<td class="c">' + notifCellule(it, p, 'notifLocataire') + '</td>'
        + '<td class="c">' + badgesRapports(it, p, 'recu') + '</td>'
        + '<td class="c">' + badgesRapports(it, p, 'envoye') + '</td>';
      return '<tr' + (annule ? ' class="annule"' : '') + '><td><b>' + cercle(p.num) + '</b> ' + (p.debut ? dh(p.debut) : 'sans date') + '<div class="fd-vide" style="font-size:12px;">' + esc(p.techs.join(', ') || 'sans technicien') + '</div></td>' + cells + '</tr>';
    }).join('');
    return '<div class="fd-section"><h3>Passages</h3><table class="fd-table"><thead><tr><th>Passage</th><th>Agenda</th><th>Kizeo</th><th>Client</th><th>Locataire</th><th>Rapport reçu</th><th>Rapport envoyé</th></tr></thead><tbody>' + lignes + '</tbody></table></div>';
  }

  function sectionRapports(rapports) {
    if (!rapports) return '<div class="fd-section"><h3>Rapports</h3><p class="fd-vide">Chargement…</p></div>';
    if (!rapports.length) return '<div class="fd-section"><h3>Rapports</h3><p class="fd-vide">Aucun rapport pour ce dossier.</p></div>';
    var l = rapports.slice().sort(function (a, b) { return (a.numPassage || 0) - (b.numPassage || 0); }).map(function (r) {
      var origine = r.origine === 'manuel' ? 'Manuel' : r.typeRapport === 'absence-annulation' ? 'Constat d\'absence' : 'Kizeo';
      return '<tr><td>' + cercle(r.numPassage) + ' ' + esc(r.libelle || r.passageLabel || '') + '</td><td>' + origine + '</td><td>' + esc(LIB_STATUT_RAPPORT[r.statut] || r.statut || '') + '</td>'
        + '<td>' + esc(r.technicien || r.ajoutePar || '—') + '</td>'
        + '<td>' + (r.statut !== 'en-attente' && r.arriveeAt ? dh(r.arriveeAt) : '—') + '</td>'
        + '<td>' + (r.notifiedAt ? dh(r.notifiedAt) : '—') + '</td>'
        + '<td>' + (r.fileUrl ? '<a class="fd-lien" href="' + esc(r.fileUrl) + '" target="_blank" rel="noopener">' + (r.type === 'excel' ? 'Excel' : 'PDF') + '</a>' : '') + '</td></tr>';
    }).join('');
    return '<div class="fd-section"><h3>Rapports</h3><table class="fd-table"><thead><tr><th>Passage</th><th>Origine</th><th>Statut</th><th>Technicien</th><th>Reçu</th><th>Envoyé</th><th></th></tr></thead><tbody>' + l + '</tbody></table></div>';
  }

  function sectionFacturation(it, factures) {
    var etape = fileDe(it);
    if (it.clientType === 'tache') return '<div class="fd-section"><h3>Facturation</h3><p class="fd-vide">Tâche : pas de facturation.</p></div>';
    if (!factures) return '<div class="fd-section"><h3>Facturation</h3><p class="fd-vide">Chargement…</p></div>';
    if (!factures.length) return '<div class="fd-section"><h3>Facturation</h3><p class="fd-vide">' + (etape === 'afacturer' ? 'À facturer : passage 1 fait, rapport envoyé.' : 'Pas encore facturé.') + '</p></div>';
    var l = factures.map(function (f) {
      return '<tr><td>' + esc(f.statut || '') + '</td><td>' + esc(f.numFacture || '—') + '</td><td>' + (f.dateFacture ? dh(f.dateFacture) : '—') + '</td>'
        + '<td>' + (f.montantHT ? Number(f.montantHT).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }) + ' HT' : '—') + '</td>'
        + '<td>' + (f.paye ? 'Payé (coché à la main)' : '—') + '</td>'
        + '<td>' + (f.factureUrl ? '<a class="fd-lien" href="' + esc(f.factureUrl) + '" target="_blank" rel="noopener">PDF</a>' : '') + '</td></tr>';
    }).join('');
    return '<div class="fd-section"><h3>Facturation</h3><table class="fd-table"><thead><tr><th>Statut</th><th>N° facture</th><th>Date</th><th>Montant</th><th>Paiement</th><th></th></tr></thead><tbody>' + l + '</tbody></table></div>';
  }

  function sectionHistorique(it, donnees) {
    var ev = [];
    var ajout = function (quand, txt) { if (quand) ev.push({ q: String(quand), t: txt }); };
    ajout(it.createdAt, it.source === 'auto' ? 'BC reçu par email et importé' : 'Dossier créé à la main');
    ajout(it.validatedAt, 'Validé, passé en Planification');
    if (it.attenteDepuis) ajout(it.attenteDepuis, 'Mis en attente' + (it.motifAttente ? ' : ' + esc(it.motifAttente) : ''));
    if (it.annuleLe) ajout(it.annuleLe, 'Commande annulée' + (it.motifAnnulation ? ' : ' + esc(it.motifAnnulation) : ''));
    var manuelles = Array.isArray(it.notifsManuelles) ? it.notifsManuelles : [];
    var notif = function (champ, type, lib) {
      toNotifArray(it[champ]).forEach(function (ts) {
        var m = manuelles.find(function (x) { return x.type === type && x.le === ts; });
        ajout(ts, lib + (m ? ' ' + esc(((window.LIB_MOYEN_NOTIF || {})[m.moyen]) || 'autrement') + ' (validé à la main' + (m.par ? ' par ' + esc(String(m.par).split('@')[0]) : '') + ')' + (m.note ? ' · ' + esc(m.note) : '') : ' par email depuis l\'app'));
      });
    };
    notif('notifBailleur', 'bailleur', 'Client prévenu');
    notif('notifLocataire', 'locataire', 'Locataire prévenu');
    toNotifArray(it.notifSms).forEach(function (ts) { ajout(ts, 'SMS envoyé au locataire'); });
    toNotifArray(it.notifRappelSms).forEach(function (ts) { ajout(ts, 'Rappel SMS envoyé'); });
    passagesNorm(it).forEach(function (p) {
      if (p.kizeo && p.kizeoLe) ajout(p.kizeoLe, 'Formulaire Kizeo envoyé' + (p.kizeoTech ? ' à ' + esc(p.kizeoTech) : '') + ' (passage ' + p.num + (p.kzNom ? ', ' + esc(p.kzNom) : '') + ')');
    });
    (donnees && donnees.rapports || []).forEach(function (r) {
      if (r.statut !== 'en-attente' && r.arriveeAt) ajout(r.arriveeAt, (r.origine === 'manuel' ? 'Rapport manuel déposé' + (r.ajoutePar ? ' par ' + esc(String(r.ajoutePar).split('@')[0]) : '') : r.typeRapport === 'absence-annulation' ? 'Constat d\'absence reçu' : 'Rapport reçu du technicien') + ' (passage ' + (r.numPassage || '?') + ')');
      if (r.notifiedAt) ajout(r.notifiedAt, 'Rapport envoyé au client (passage ' + (r.numPassage || '?') + ')' + (r.ajouteEspaceClient ? ', ajouté à l\'espace client' : ''));
    });
    (donnees && donnees.factures || []).forEach(function (f) {
      if (f.dateFacture) ajout(f.dateFacture, 'Facture ' + esc(f.numFacture || '') + ' émise');
    });
    ev.sort(function (a, b) { return a.q.localeCompare(b.q); });
    var li = ev.map(function (e) { return '<li><span>' + dh(e.q) + '</span><span>' + e.t + '</span></li>'; }).join('');
    return '<div class="fd-section"><h3>Historique</h3>' + (li ? '<ul class="fd-histo">' + li + '</ul>' : '<p class="fd-vide">Rien d\'enregistré.</p>')
      + '<p class="fd-vide" style="font-size:11.5px;margin-top:8px;">Les modifications de dates ou de techniciens ne sont pas historisées.</p></div>';
  }

  function rendre(it, donnees) {
    var el = racine();
    var etape = fileDe(it);
    var ref = it.bc ? 'BC ' + it.bc : it.pl ? 'PL ' + it.pl : it.devis ? 'Devis ' + it.devis : (it.clientType === 'tache' ? 'Tâche' : 'Sans référence');
    var facture = it.clientType !== 'tache' && it.enFacturation && etape !== 'cloture' ? ' <span class="psg psg-ok" style="text-decoration:none;">Facturé</span>' : '';
    el.querySelector('.fd-tete').innerHTML = '<div style="flex:1;"><h2>' + esc(ref) + ' ' + etiquetteEtape(it) + facture + '</h2><small>' + esc([it.client, it.nature, it.adresse].filter(Boolean).join(' · ')) + '</small></div>'
      + '<button class="btn-ellipsis" onclick="fermerFicheDossier()" title="Fermer" style="font-size:18px;">×</button>';
    el.querySelector('.fd-corps').innerHTML = sectionPassages(it) + sectionRapports(donnees && donnees.rapports) + sectionFacturation(it, donnees && donnees.factures) + sectionDossier(it) + sectionHistorique(it, donnees);
    var modif = etape === 'validation' ? '' : '<button class="btn-primary" onclick="fermerFicheDossier();ouvrirPlanification(\'' + it.id + '\',' + (etape === 'planification' ? 0 : 1) + ')">Modifier</button>';
    el.querySelector('.fd-pied').innerHTML = modif
      + (it.clientType !== 'tache' && passagesNorm(it).length ? '<button class="btn-next neutre" onclick="openNotifFromRow(\'' + it.id + '\')">Notifier client / locataire</button>' : '')
      // Transition (16/11) : l'ancienne fiche reste joignable d'ici, le temps de vérifier que rien ne manque
      + '<button class="fd-discret" onclick="fermerFicheDossier();openModal(\'' + it.id + '\')" title="Ancien formulaire complet, à n\'utiliser qu\'en dépannage">ancienne fiche</button>';
  }

  window.ouvrirFicheDossier = function (id) {
    var it = (window.interventions || []).find(function (i) { return i.id === id; });
    if (!it) return;
    var el = racine();
    el.classList.add('ouvert');
    el.dataset.id = id;
    rendre(it, null);
    if (typeof window._chargerFicheDossier === 'function') {
      window._chargerFicheDossier(id).then(function (d) {
        if (el.dataset.id !== id || !el.classList.contains('ouvert')) return;
        var frais = (window.interventions || []).find(function (i) { return i.id === id; }) || it;
        rendre(frais, d);
      }).catch(function (e) { console.warn('fiche dossier :', e.message); rendre(it, { rapports: [], factures: [] }); });
    }
  };
  window.fermerFicheDossier = function () { var el = document.getElementById('ficheDossier'); if (el) { el.classList.remove('ouvert'); el.dataset.id = ''; } };
})();
