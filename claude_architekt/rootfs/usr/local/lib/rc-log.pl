#!/usr/bin/perl
# Filter fuer die Ausgabe von 'claude remote-control' (stdin) ins Add-on-Log (stdout), aufgerufen
# von rc_log in run.sh. Umgebung: ROLE (Praefix im Log), STATUS_FILE (Zustand fuer Login-Seite und HA,
# gleiche Form wie status_set: {"zustand","text","seit"}).
#
# Die Statusanzeige wird alle paar Sekunden neu gezeichnet (sonst zehntausende Zeilen pro Stunde):
# Steuerzeichen entfernen, Verbindungs- und Kapazitaetszeile nur bei Aenderung, alle anderen Zeilen
# (Sitzungen, Hinweise, Fehler) beim ersten Mal.
#
# Zustand aus der Anzeige der CLI (Bridge-Logger von claude 2.1.x):
#   "Ready · <name> · <branch>"       Statuszeile im Leerlauf (verbunden, keine Sitzung)     -> ok
#   "Connected · <name> · <branch>"   Statuszeile mit Sitzung                                -> ok
#   "Capacity: n/m · …"               zeichnet die CLI nur unter der Statuszeile, nie beim
#                                     Neuverbinden (auch mit Sitzungstitel statt Statuswort)  -> ok
#   "[hh:mm:ss] Reconnected after Ns" Verbindung wieder da                                   -> ok
#   "Reconnecting · retrying in …"    Verbindung unterbrochen                                -> verbindung
#   "Connecting"                      Spinner, nur beim Start bis zur ersten Abfrage; kurz davor
#                                     kann die Statuszeile einmal aufblitzen                  -> startet
#   "must be logged in" u. a.         Login-Fehler                                            -> login
# Zeilen aus logStatus/logReconnected tragen vorne "[hh:mm:ss] "; das wird fuer den Vergleich entfernt.
use strict;
use warnings;
use POSIX qw(strftime);

$| = 1;
my $akt = "";
my (%last, %seen);

sub zustand {
  my ($z, $t) = @_;
  return if $z eq $akt;
  $akt = $z;
  my $s = strftime("%Y-%m-%dT%H:%M:%S%z", localtime); $s =~ s/(\d\d)$/:$1/;
  my $f = $ENV{STATUS_FILE};
  open(my $o, ">", "$f.tmp") or return;
  print $o qq({"zustand":"$z","text":"$t","seit":"$s"}\n); close $o;
  chmod 0644, "$f.tmp"; rename "$f.tmp", $f;
}

while (<STDIN>) {
  s/\e\][^\a\e]*(?:\a|\e\\)//g; s/\e\[[0-9;?]*[A-Za-z]//g; s/[\r\n]//g;
  s/^[^[:alnum:]\[]+//;  # Rahmen-/Spinnerzeichen am Anfang
  next unless length;
  (my $m = $_) =~ s/^\[\d\d:\d\d:\d\d\]\s*//;  # Zeitstempel der CLI
  if ($m =~ /^(?:Ready|Connected)(?:\s+\xc2\xb7|\s*$)/ || $m =~ /^Capacity:\s*\d+\/\d+/
      || $m =~ /^Reconnected\b/) {
    zustand("ok", "Verbunden") }
  elsif ($m =~ /^(?:Reconnecting|Disconnected|Offline)\b/i) {
    zustand("verbindung", "Verbindung unterbrochen – verbindet neu") }
  elsif ($m =~ /^Connecting\b/) {
    zustand("startet", "Verbindet …") if $akt eq "ok" }
  elsif (/must be logged in|requires a claude\.ai subscription/) {
    zustand("login", "Login ungueltig oder abgelaufen – bitte neu anmelden") }
  my $k = $m =~ /^Capacity:/ ? "cap"
        : /^Ready\b|Connected|Connecting|Reconnect|Disconnected|offline/ ? "status" : "";
  if ($k) { next if ($last{$k} // "") eq $_; $last{$k} = $_ }
  else    { next if $seen{$_}++; %seen = ($_ => 1) if keys %seen > 500 }
  my @t = localtime; printf "[%04d-%02d-%02d %02d:%02d:%02d] [%s] rc: %s\n",
    $t[5] + 1900, $t[4] + 1, @t[3, 2, 1, 0], $ENV{ROLE} // "", $_;
}
